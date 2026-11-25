import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SceneOutline } from '@openmaic/generation';
import { resolveModel } from '@/lib/server/resolve-model';
import { supportsNativeManimTools } from '@/lib/visualization/agent-tools';
import { diagnoseManimAuthoring } from '@/lib/visualization/generate';
import { VisualizationFailure } from '@/lib/visualization/failure';
import { createManimAiCall, dedicatedManimModel } from '@/lib/visualization/model';

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

async function main() {
  const routed =
    dedicatedManimModel() ??
    (process.env.LLM_ROUTER_ENABLED === 'true' ? process.env.LLM_ROUTER_PRIMARY_MODEL : undefined);
  const model = routed
    ? { model: routed, providerId: routed.split(':')[0], modelString: routed }
    : await resolveModel({ stage: 'scene-content:visualization' });
  const candidate = await diagnoseManimAuthoring({
    outline,
    allOutlines: [outline],
    ownerId: 'operator-diagnostic',
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
  });
  const validation = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      `
import json, sys
sys.path.insert(0, sys.argv[1])
from native_contract import Rejected, check_request
try:
    check_request(json.load(sys.stdin))
except Rejected as exc:
    print(exc.issue["code"])
    sys.exit(1)
`,
      resolve('services/manim-renderer'),
    ],
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
  const issue = validation.stdout?.trim();
  console.log(
    JSON.stringify({
      event: 'manim-model-diagnostic',
      elapsedMs: Date.now() - started,
      submittedPython: true,
      validPython: validation.status === 0,
      validation:
        validation.status === 0
          ? 'passed'
          : issue && /^[a-zA-Z]{1,24}$/.test(issue)
            ? issue
            : 'local_validator_unavailable',
      pythonBytes: Buffer.byteLength(candidate.source),
      cues: candidate.segments.length,
    }),
  );
  if (validation.status !== 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'manim-model-diagnostic',
      elapsedMs: Date.now() - started,
      submittedPython: false,
      validPython: false,
      failureCode:
        error instanceof VisualizationFailure
          ? error.code
          : controller.signal.aborted
            ? 'cancelled'
            : 'diagnostic_unavailable',
    }),
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
