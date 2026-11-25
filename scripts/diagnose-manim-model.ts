import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SceneOutline } from '@openmaic/generation';
import { resolveModel } from '@/lib/server/resolve-model';
import { supportsNativeManimTools } from '@/lib/visualization/agent-tools';
import { diagnoseManimAuthoring, type DiagnosticExchange } from '@/lib/visualization/generate';
import { renderRepairFeedback, VisualizationFailure } from '@/lib/visualization/failure';
import { createManimAiCall, dedicatedManimModel } from '@/lib/visualization/model';
import {
  rendererFetch,
  RendererError,
  type RenderIssue,
  type RenderJob,
} from '@/lib/visualization/renderer';
import type { Candidate } from '@/lib/visualization/submission';

const outline: SceneOutline = {
  id: 'operator-model-diagnostic',
  order: 1,
  type: 'visualization',
  title: 'A point moves along a number line',
  description: 'Show a number line, then animate a dot from zero to two.',
  keyPoints: ['Use two short named cues.', 'Keep the numbers visible as the dot moves.'],
};

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const started = Date.now();
const ownerId = `operator-manim-model-${randomUUID()}`;
let submittedPython = false;
let validPython = false;
let pythonVersion: string | undefined;

const validationProgram = `
import json, sys
sys.path.insert(0, sys.argv[1])
from native_contract import Rejected, check_request
result = {"version": ".".join(map(str, sys.version_info[:3]))}
try:
    check_request(json.load(sys.stdin))
except Rejected as exc:
    result["issue"] = exc.issue
print(json.dumps(result))
`;

function validate(candidate: Candidate, signal: AbortSignal, python: string, container?: string) {
  signal.throwIfAborted();
  submittedPython = true;
  validPython = false;
  const args = [
    '-I',
    '-B',
    '-c',
    validationProgram,
    container ? '/opt/sahaya-manim' : resolve('services/manim-renderer'),
  ];
  const result = spawnSync(
    container ? 'docker' : python,
    container ? ['exec', '-i', '--user', '1000:1000', container, 'python', ...args] : args,
    {
      input: JSON.stringify({
        ...candidate,
        quality: 'preview',
        publication: 'none',
        minimums: {},
      }),
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 8192,
    },
  );
  signal.throwIfAborted();
  if (result.status !== 0)
    throw new VisualizationFailure('VISUALIZATION_PREPARATION', 'diagnostic_validator_unavailable');
  let check: { version?: string; issue?: RenderIssue };
  try {
    check = JSON.parse(result.stdout);
    if (!check || !/^\d+\.\d+\.\d+$/.test(check.version ?? '')) throw new Error();
  } catch {
    throw new VisualizationFailure('VISUALIZATION_PREPARATION', 'diagnostic_validator_response');
  }
  pythonVersion = check.version;
  validPython = !check.issue;
  const issue = check.issue && renderRepairFeedback(check.issue);
  console.log(
    JSON.stringify({
      event: 'manim-model-static-validation',
      interpreter: container ? 'publisher' : 'local',
      pythonVersion,
      validPython,
      issueCode: issue?.code,
      issueLine: issue?.line,
    }),
  );
  if (issue) throw new RendererError(422, issue);
}

function captureExchange(folder: string, exchange: DiagnosticExchange) {
  const tag = `turn-${exchange.turn}`;
  const { format, outcome } = exchange.extraction;
  const response = JSON.stringify(
    { format, outcome, text: exchange.text, toolCalls: exchange.toolCalls },
    null,
    2,
  );
  if (Buffer.byteLength(response) <= 192 * 1024)
    writeFileSync(join(folder, `${tag}.response.json`), response, { mode: 0o600, flag: 'wx' });
  const candidate =
    exchange.extraction.outcome === 'submitted' ? exchange.extraction.candidate : undefined;
  const source =
    candidate?.source ?? ('source' in exchange.extraction ? exchange.extraction.source : undefined);
  if (source && Buffer.byteLength(source) <= 48 * 1024)
    writeFileSync(join(folder, `${tag}.py`), source, { mode: 0o600, flag: 'wx' });
  if (candidate)
    writeFileSync(join(folder, `${tag}.cues.json`), JSON.stringify(candidate.segments, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
}

async function verifyPreview(artifact: NonNullable<RenderJob['artifact']>) {
  const expectedSize = artifact.bytes;
  const invalid = () =>
    new VisualizationFailure('VISUALIZATION_ARTIFACT_VALIDATION', 'diagnostic_preview_invalid');
  if (
    artifact.verification?.media !== 'decoded' ||
    artifact.quality !== 'preview' ||
    !/^[a-f0-9]{64}$/.test(artifact.artifactId) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 16 ||
    expectedSize > 50 * 1024 * 1024
  )
    throw invalid();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
  const response = await rendererFetch(
    ownerId,
    `/artifacts/${artifact.artifactId}/video.mp4`,
    { signal },
    true,
  );
  const reader = response.body?.getReader();
  if (!response.ok || !reader || Number(response.headers.get('Content-Length')) !== expectedSize) {
    await reader?.cancel();
    throw invalid();
  }
  const hash = createHash('sha256');
  const header = Buffer.alloc(8);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > expectedSize) throw invalid();
      if (size < header.length) header.set(value.subarray(0, header.length - size), size);
      size += value.byteLength;
      hash.update(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (
    size !== expectedSize ||
    header.toString('ascii', 4) !== 'ftyp' ||
    hash.digest('hex') !== artifact.sha256
  )
    throw invalid();
}

async function main() {
  const { values } = parseArgs({
    options: {
      python: { type: 'string' },
      'publisher-container': { type: 'string' },
      preview: { type: 'boolean' },
      capture: { type: 'boolean' },
    },
  });
  const container = values['publisher-container'];
  if (
    container !== undefined &&
    (values.python !== undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))
  )
    throw new VisualizationFailure(
      'VISUALIZATION_PREPARATION',
      'choose_one_validation_interpreter',
    );
  const folder = values.capture
    ? mkdtempSync(join(tmpdir(), 'sahaya-manim-diagnostic-'))
    : undefined;
  if (folder) console.log(JSON.stringify({ event: 'manim-model-capture', directory: folder }));
  const routed =
    dedicatedManimModel() ??
    (process.env.LLM_ROUTER_ENABLED === 'true' ? process.env.LLM_ROUTER_PRIMARY_MODEL : undefined);
  const model = routed
    ? { model: routed, providerId: routed.split(':')[0], modelString: routed }
    : await resolveModel({ stage: 'scene-content:visualization' });
  const { candidate, artifact } = await diagnoseManimAuthoring(
    {
      outline,
      allOutlines: [outline],
      ownerId,
      trace: {
        stageId: 'operator-diagnostic',
        requestId: 'operator-diagnostic',
        model: model.modelString,
        provider: model.providerId,
      },
      aiCall: createManimAiCall({
        model: model.model,
        outputWindow: 'modelInfo' in model ? model.modelInfo?.outputWindow : undefined,
        thinking: 'thinkingConfig' in model ? model.thinkingConfig : undefined,
      }),
      nativeTools:
        !routed &&
        supportsNativeManimTools(
          model.providerId,
          model.modelString,
          'baseUrl' in model ? model.baseUrl : undefined,
        ),
      signal: controller.signal,
    },
    {
      preview: values.preview === true,
      validate: (candidate, signal) =>
        validate(candidate, signal, values.python ?? 'python3', container),
      capture: folder ? (exchange) => captureExchange(folder, exchange) : undefined,
    },
  );
  if (artifact) await verifyPreview(artifact);
  console.log(
    JSON.stringify({
      event: 'manim-model-diagnostic',
      elapsedMs: Date.now() - started,
      submittedPython,
      validPython,
      pythonVersion,
      playableArtifact: artifact ? true : undefined,
      artifactId: artifact?.artifactId,
      pythonBytes: Buffer.byteLength(candidate.source),
      cues: candidate.segments.length,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'manim-model-diagnostic',
      elapsedMs: Date.now() - started,
      submittedPython,
      validPython,
      pythonVersion,
      ...(submittedPython && { playableArtifact: false }),
      failureCode:
        error instanceof VisualizationFailure
          ? error.code
          : controller.signal.aborted
            ? 'cancelled'
            : 'diagnostic_unavailable',
      reason: error instanceof VisualizationFailure ? error.detail : undefined,
    }),
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
