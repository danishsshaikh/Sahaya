import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';

const FLAGS = [
  'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED',
  'OPENMAIC_AGENT_RUNTIME_ENABLED',
  'DATABASE_URL',
] as const;

describe('workbench entry gate', () => {
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of FLAGS) {
      originals.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of FLAGS) {
      const original = originals.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    originals.clear();
  });

  it.each([
    ['all flags are absent', undefined, undefined, undefined],
    ['the public entry flag is off', undefined, 'true', 'postgres://runtime'],
    ['the runtime is off', 'true', undefined, 'postgres://runtime'],
    ['the database URL is absent', 'true', 'true', undefined],
    ['the database URL is blank', 'true', 'true', '   '],
  ])('keeps both entry routes closed when %s', (_case, publicFlag, runtimeFlag, databaseUrl) => {
    if (publicFlag !== undefined) process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED = publicFlag;
    if (runtimeFlag !== undefined) process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = runtimeFlag;
    if (databaseUrl !== undefined) process.env.DATABASE_URL = databaseUrl;

    expect(isWorkbenchEntryEnabled()).toBe(false);
  });

  it('opens both entry routes only for an enabled, configured runtime', () => {
    process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED = 'true';
    process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = 'true';
    process.env.DATABASE_URL = 'postgres://runtime';

    expect(isWorkbenchEntryEnabled()).toBe(true);
  });

  it('keeps standalone classroom Pro controls behind the workbench entry gate', () => {
    const stageSource = readFileSync(join(process.cwd(), 'components/stage.tsx'), 'utf8');

    expect(stageSource).toContain('const chromeToggleHandler = hosted');
    expect(stageSource).toContain(
      'proWorkbenchEntry\n        ? handleEnterWorkbench\n        : undefined',
    );
    expect(stageSource).toContain(
      'canEnterProMode={Boolean(chromeToggleHandler) && (workbenchPlayback || isEditable)}',
    );
    expect(stageSource).not.toContain(': toggleHandler');
    expect(stageSource).not.toContain("from '@/lib/edit/enter-edit-mode'");
  });
});
