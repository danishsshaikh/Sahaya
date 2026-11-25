import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { manimAgentBudget } from '@/lib/visualization/budget';
import { manimDiagnosticTasks } from './manim-diagnostic-tasks';

const tasks = [
  'number-line',
  'function-plot',
  'single-slit-diffraction',
] as const satisfies readonly (keyof typeof manimDiagnosticTasks)[];
type Task = (typeof tasks)[number];
type Trial = {
  elapsedMs: number;
  playableArtifact?: boolean;
  modelCalls: number;
  correctionCalls: number;
  patchesApplied: number;
  pythonSubmissions: number;
  failureCode?: string;
};

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

function run(task: Task, profile: string, env: NodeJS.ProcessEnv, extraArgs: string[]) {
  return new Promise<Trial>((resolve) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [
        '--conditions=import',
        '--import',
        'tsx',
        'scripts/diagnose-manim-model.ts',
        '--task',
        task,
        '--preview',
        '--fixed-knowledge',
        ...extraArgs,
      ],
      { env, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let report: Trial | undefined;
    for (const input of [child.stdout, child.stderr]) {
      createInterface({ input }).on('line', (line) => {
        try {
          const record = JSON.parse(line);
          if (record.event === 'manim-model-diagnostic') {
            const {
              elapsedMs,
              playableArtifact,
              modelCalls,
              correctionCalls,
              patchesApplied,
              pythonSubmissions,
              failureCode,
            } = record;
            report = {
              elapsedMs,
              playableArtifact,
              modelCalls,
              correctionCalls,
              patchesApplied,
              pythonSubmissions,
              failureCode,
            };
          }
          if (record.event === 'manim-model-capture')
            console.log(
              JSON.stringify({ event: record.event, task, profile, directory: record.directory }),
            );
        } catch {
          /* The child can emit Node warnings as well as JSON events. */
        }
      });
    }
    child.on('error', () => {});
    child.on('close', (status) =>
      resolve(
        report
          ? { ...report, playableArtifact: status === 0 && report.playableArtifact === true }
          : {
              elapsedMs: Date.now() - start,
              modelCalls: 0,
              correctionCalls: 0,
              patchesApplied: 0,
              pythonSubmissions: 0,
              failureCode: 'diagnostic_process_failed',
            },
      ),
    );
  });
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2
    : undefined;
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', multiple: true },
      runs: { type: 'string', default: '1' },
      capture: { type: 'boolean' },
      'publisher-container': { type: 'string' },
    },
  });
  const labels = values.profile ?? [];
  const runs = Number(values.runs);
  if (
    labels.length < 2 ||
    new Set(labels).size !== labels.length ||
    labels.some((label) => !/^[A-Z][A-Z0-9_]{0,23}$/.test(label))
  )
    throw new Error(
      'Provide at least two distinct approved --profile names using uppercase letters, digits and underscores.',
    );
  if (!Number.isInteger(runs) || runs < 1 || runs > 10)
    throw new Error('--runs must be between 1 and 10.');

  const profiles = new Map(
    labels.map((label) => {
      const prefix = 'MANIM_BENCH_' + label;
      const read = (key: string) => process.env[prefix + '_' + key] ?? '';
      const model = read('MODEL');
      const endpoint = read('BASE_URL');
      if (!/^[A-Za-z0-9._-]+:[A-Za-z0-9._/:+\-]+$/.test(model) || !endpoint.trim())
        throw new Error('Set MODEL and BASE_URL for approved profile ' + label);
      return [
        label,
        {
          MANIM_MODEL_PRIMARY_MODEL: model,
          MANIM_MODEL_PRIMARY_BASE_URL: endpoint,
          MANIM_MODEL_PRIMARY_API_KEY: read('API_KEY'),
          MANIM_MODEL_PRIMARY_LOCAL: read('LOCAL'),
          MANIM_MODEL_PRIMARY_LLAMA_CPP: read('LLAMA_CPP'),
          MANIM_MODEL_PRIMARY_DISABLE_REASONING: read('DISABLE_REASONING'),
        },
      ];
    }),
  );
  const targets = [...profiles.values()].map((profile) =>
    JSON.stringify([
      profile.MANIM_MODEL_PRIMARY_MODEL,
      profile.MANIM_MODEL_PRIMARY_BASE_URL.trim().replace(/\/+$/, ''),
    ]),
  );
  if (new Set(targets).size !== targets.length)
    throw new Error('Benchmark profiles must target distinct models or endpoints.');
  const limits = manimAgentBudget();
  const allLocal = [...profiles.values()].every(
    ({ MANIM_MODEL_PRIMARY_LOCAL }) => MANIM_MODEL_PRIMARY_LOCAL === 'true',
  );
  const configured = Number(process.env.MANIM_MODEL_PRIMARY_TIMEOUT_SECONDS);
  const timeout = Math.min(
    limits.inferenceMs / 1000,
    allLocal ? Infinity : limits.remoteInferenceMs / 1000,
    Number.isInteger(configured) && configured > 0 ? configured : Infinity,
  );
  const shared = {
    ...process.env,
    LOG_LEVEL: 'error',
    CONTEXT7_API_KEY: '',
    MANIM_MODEL_SECONDARY_MODEL: '',
    MANIM_MODEL_FALLBACK_MODEL: '',
    MANIM_MODEL_PRIMARY_TIMEOUT_SECONDS: String(timeout),
  };
  const extraArgs = [
    ...(values['publisher-container']
      ? ['--publisher-container', values['publisher-container']]
      : []),
    ...(values.capture ? ['--capture'] : []),
  ];
  console.log(
    JSON.stringify({
      event: 'manim-benchmark-settings',
      tasks,
      runs,
      models: [...profiles].map(([profile, env]) => ({
        profile,
        model: env.MANIM_MODEL_PRIMARY_MODEL,
      })),
      timeoutSeconds: timeout,
      contextTokens: limits.contextTokens,
      completionTokens: limits.completionTokens,
    }),
  );
  const results: (Trial & { profile: string; task: Task })[] = [];
  for (let repetition = 0; repetition < runs; repetition++) {
    for (const task of tasks) {
      for (let position = 0; position < labels.length; position++) {
        controller.signal.throwIfAborted();
        const profile = labels[(position + repetition) % labels.length];
        const result = {
          profile,
          task,
          ...(await run(task, profile, { ...shared, ...profiles.get(profile) }, extraArgs)),
        };
        console.log(
          JSON.stringify({
            event: 'manim-benchmark-trial',
            repetition: repetition + 1,
            ...result,
            firstPass:
              result.playableArtifact === true &&
              result.pythonSubmissions === 1 &&
              result.correctionCalls === 0,
            repaired: result.playableArtifact === true && result.patchesApplied > 0,
          }),
        );
        results.push(result);
      }
    }
  }
  for (const profile of labels) {
    const trials = results.filter((trial) => trial.profile === profile);
    const playable = trials.filter((trial) => trial.playableArtifact);
    console.log(
      JSON.stringify({
        event: 'manim-benchmark-summary',
        profile,
        trials: trials.length,
        firstPass: playable.filter(
          (trial) => trial.pythonSubmissions === 1 && trial.correctionCalls === 0,
        ).length,
        repairAttempts: trials.filter((trial) => trial.correctionCalls > 0).length,
        repaired: playable.filter((trial) => trial.patchesApplied > 0).length,
        playable: playable.length,
        medianElapsedMs: median(trials.map((trial) => trial.elapsedMs)),
        medianPlayableElapsedMs: median(playable.map((trial) => trial.elapsedMs)),
      }),
    );
  }
}

void main().catch((error: unknown) => {
  console.error(
    controller.signal.aborted
      ? 'Benchmark cancelled.'
      : error instanceof Error
        ? error.message
        : 'Benchmark failed.',
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
