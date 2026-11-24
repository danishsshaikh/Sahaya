import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkWorkspaceBuild } from '@/scripts/check-workspace-build.mjs';

it('rejects source-only workspace changes and compiled DSL entries missing the Visualization exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sahaya-workspace-artifacts-'));
  try {
    const packages = join(root, 'packages/@openmaic');
    for (const name of ['dsl', 'generation']) {
      await mkdir(join(packages, name, 'src'), { recursive: true });
      await mkdir(join(packages, name, 'dist'));
      await writeFile(join(packages, name, 'package.json'), '{"type":"module"}');
    }
    const entry = join(packages, 'dsl/dist/index.js');
    await writeFile(entry, 'export const STAGE = {};');
    await writeFile(join(packages, 'generation/dist/index.js'), 'export {};');
    await expect(checkWorkspaceBuild(root, true)).rejects.toThrow('Visualization exports');
    await writeFile(
      entry,
      'export const VISUALIZATION_STYLES = []; export const VISUALIZATION_DIFFICULTIES = [];',
    );
    await checkWorkspaceBuild(root, true);
    await expect(checkWorkspaceBuild(root)).resolves.toBeUndefined();

    await writeFile(join(packages, 'generation/src/scene.ts'), 'export const changed = true;');
    await expect(checkWorkspaceBuild(root)).rejects.toThrow('older than their source');
  } finally {
    await rm(root, { recursive: true });
  }
});
