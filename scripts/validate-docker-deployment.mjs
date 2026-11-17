#!/usr/bin/env node

import { readFileSync } from 'node:fs';

/**
 * Structural validation for `docker compose config --format json`.
 *
 * This intentionally does not start containers, inspect secrets, or require a
 * GPU. It catches deployment regressions in private endpoint exposure, durable
 * mounts, browser build flags, and service health contracts.
 */

let source = '';
for await (const chunk of process.stdin) source += chunk;

function invariant(condition, message) {
  if (!condition) throw new Error(`Docker deployment validation failed: ${message}`);
}

const config = JSON.parse(source);
const services = config.services ?? {};
const app = services.openmaic;
invariant(app, 'openmaic service is missing');
invariant(app.healthcheck, 'openmaic healthcheck is missing');
invariant(app.restart === 'unless-stopped', 'openmaic restart policy must be unless-stopped');

const appNetworks = Object.keys(app.networks ?? {});
invariant(appNetworks.includes('default'), 'openmaic needs outbound provider network access');
invariant(appNetworks.includes('inference'), 'openmaic is not attached to the inference network');

const appEnvironment = app.environment ?? {};
invariant(
  appEnvironment.MING3_TTS_BASE_URL === 'http://ming3-tts:8773',
  'Ming app endpoint must use Compose DNS',
);
invariant(
  appEnvironment.QWEN3_TTS_BASE_URL === 'http://qwen3-tts:8771',
  'Qwen app endpoint must use Compose DNS',
);
invariant(
  appEnvironment.VOICE_CLONING_STORAGE_DIR === '/app/data/voice-cloning',
  'Teaching Voice storage must be in the durable app volume',
);
invariant(
  appEnvironment.OPENMAIC_AUTH_DATA_DIR === '/app/data/auth',
  'account storage must be in the durable app volume',
);

const appMounts = app.volumes ?? [];
invariant(
  appMounts.some((mount) => mount.source === 'openmaic-data' && mount.target === '/app/data'),
  'openmaic-data is not mounted at /app/data',
);

const buildArgs = app.build?.args ?? {};
const publicBuildFlags = [
  'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED',
  'NEXT_PUBLIC_ENABLE_PPTX_IMPORT',
  'NEXT_PUBLIC_ENABLE_VIDEO_EXPORT',
  'NEXT_PUBLIC_FEATURE_CLASSROOM_CHAT',
  'NEXT_PUBLIC_FEATURE_CLASSROOM_IMPORT',
  'NEXT_PUBLIC_FEATURE_COMPANION_SELECTOR',
  'NEXT_PUBLIC_FEATURE_VOICE_CLONING',
  'NEXT_PUBLIC_FEATURE_COURSE_NARRATION_SWITCHING',
  'NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES',
  'NEXT_PUBLIC_FEATURE_DISCUSSION_SCENES',
  'NEXT_PUBLIC_FEATURE_FLOW_SCENES',
  'NEXT_PUBLIC_FEATURE_GENERATED_CLASSROOM_AGENTS',
  'NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES',
  'NEXT_PUBLIC_FEATURE_PROMPT_PERSONALIZATION',
  'NEXT_PUBLIC_FEATURE_STATIC_VOICE',
  'NEXT_PUBLIC_FEATURE_WEB_SEARCH',
  'NEXT_PUBLIC_FEATURE_WHITEBOARD',
  'NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES',
  'NEXT_PUBLIC_INTERACTIVE_CAPABILITY_TRACE',
  'NEXT_PUBLIC_MAIC_EDITOR_ENABLED',
  'NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED',
  'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED',
  'NEXT_PUBLIC_PERSISTENCE',
  'NEXT_PUBLIC_PERSISTENCE_TOKEN',
  'NEXT_PUBLIC_PI_CHAT_ENABLED',
  'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED',
  'NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI',
  'NEXT_PUBLIC_VIDEO_EXPORT_BURN_IN_CAPTIONS',
  'NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION',
  'NEXT_PUBLIC_VIDEO_SPOTLIGHT_PARITY_TRACE',
];
const dockerfile = readFileSync('Dockerfile', 'utf8');
for (const flag of publicBuildFlags) {
  invariant(Object.hasOwn(buildArgs, flag), `${flag} is not passed to the browser build`);
  invariant(dockerfile.includes(`ARG ${flag}`), `Dockerfile does not declare ${flag}`);
  invariant(dockerfile.includes(`ENV ${flag}=`), `Dockerfile does not compile ${flag}`);
}

for (const name of ['llama-gemma', 'ming3-tts', 'qwen3-tts']) {
  const service = services[name];
  invariant(service, `${name} service is missing`);
  invariant(!service.ports || service.ports.length === 0, `${name} must not publish a host port`);
  invariant(service.expose?.length > 0, `${name} must expose its internal endpoint`);
  invariant(service.healthcheck, `${name} healthcheck is missing`);
  invariant(service.restart === 'unless-stopped', `${name} restart policy must be unless-stopped`);
  invariant(
    Object.hasOwn(service.networks ?? {}, 'inference'),
    `${name} is not attached to the private inference network`,
  );
}

for (const name of ['postgres', 'render-service']) {
  const service = services[name];
  invariant(service?.healthcheck, `${name} healthcheck is missing`);
  invariant(service.restart === 'unless-stopped', `${name} restart policy must be unless-stopped`);
}

invariant(config.networks?.inference?.internal === true, 'inference network must be internal');
for (const volume of ['openmaic-data', 'openmaic-postgres', 'sahaya-huggingface-cache']) {
  invariant(Object.hasOwn(config.volumes ?? {}, volume), `${volume} volume is missing`);
}

const mingMounts = services['ming3-tts'].volumes ?? [];
invariant(
  mingMounts.some(
    (mount) => mount.source === 'openmaic-data' && mount.target === '/app/data' && !mount.read_only,
  ),
  'Ming must share writable owner-scoped voice storage for its private embedding cache',
);
const qwenMounts = services['qwen3-tts'].volumes ?? [];
invariant(
  qwenMounts.some(
    (mount) => mount.source === 'openmaic-data' && mount.target === '/app/data' && mount.read_only,
  ),
  'Qwen must share read-only owner-scoped reference storage',
);

const readme = readFileSync('README.md', 'utf8');
for (const heading of [
  'Quick start (external APIs, no local GPU)',
  'Optional local Gemma endpoint (llama.cpp)',
  'Optional Ming 3.0 TTS 0.5B (default Teaching Voice)',
  'Optional Qwen3-TTS 1.7B',
  'NVIDIA and model-loading requirements',
  'Container networking',
  'Stop, restart, and update safely',
  'Common Docker problems',
]) {
  invariant(readme.includes(heading), `README is missing the ${heading} section`);
}

const exampleEnv = readFileSync('.env.example', 'utf8');
for (const key of ['SARVAM_API_KEY', 'BODHAN_API_KEY', 'OPENAI_API_KEY']) {
  invariant(
    new RegExp(`^(?:# )?${key}=$`, 'm').test(exampleEnv),
    `.env.example must keep ${key} as an empty placeholder`,
  );
}

console.log(
  'Docker deployment structure and newcomer documentation are valid ' +
    '(app, persistence, and 3 private GPU services).',
);
