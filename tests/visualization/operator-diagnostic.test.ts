import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads the model diagnostic through Node with the import export condition', () => {
  // With the base URL missing, the CLI takes its normal configuration-error
  // path without contacting an inference or documentation endpoint.
  const result = spawnSync(
    process.execPath,
    ['--conditions=import', '--import', 'tsx', 'scripts/diagnose-manim-model.ts'],
    {
      env: {
        ...process.env,
        CONTEXT7_API_KEY: '',
        LOG_LEVEL: 'error',
        MANIM_MODEL_PRIMARY_MODEL: 'openai:diagnostic-load-fixture',
        MANIM_MODEL_PRIMARY_BASE_URL: '',
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  expect(JSON.parse(result.stderr)).toMatchObject({
    event: 'manim-model-diagnostic',
    submittedPython: false,
    failureCode: 'VISUALIZATION_MODEL_UNAVAILABLE',
  });
});
