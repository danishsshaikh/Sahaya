import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = 'packages/.workspace-build-stamp.json';
const PACKAGES = ['dsl', 'generation'];
const REQUIRED_DSL_EXPORTS = ['VISUALIZATION_STYLES', 'VISUALIZATION_DIFFICULTIES'];

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : entry.isFile() ? [path] : [];
  });
}

export function workspaceFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of PACKAGES) {
    const directory = join(root, 'packages', '@openmaic', name);
    const buildInputs = readdirSync(directory).filter(
      (name) =>
        /^tsconfig.*\.json$/.test(name) || /^tsup\.config/.test(name) || name === 'package.json',
    );
    const files = [
      ...buildInputs.map((name) => join(directory, name)),
      ...filesIn(join(directory, 'src')),
      ...filesIn(join(directory, 'scripts')),
    ];
    for (const file of files.sort()) {
      hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
    }
  }
  return hash.digest('hex');
}

async function verifyEntries(root) {
  const dslEntry = join(root, 'packages/@openmaic/dsl/dist/index.js');
  const generationEntry = join(root, 'packages/@openmaic/generation/dist/index.js');
  if (!existsSync(dslEntry) || !existsSync(generationEntry)) {
    throw new Error('Compiled DSL or generation entry point is missing.');
  }
  const entry = pathToFileURL(dslEntry);
  entry.searchParams.set(
    'content',
    createHash('sha256').update(readFileSync(dslEntry)).digest('hex'),
  );
  const dslExports = await import(entry.href);
  if (!REQUIRED_DSL_EXPORTS.every((name) => Array.isArray(dslExports[name]))) {
    throw new Error('Compiled DSL is missing the Visualization exports.');
  }
}

export async function checkWorkspaceBuild(root, record = false) {
  const path = join(root, STAMP);
  const fingerprint = workspaceFingerprint(root);
  if (
    !record &&
    (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).fingerprint !== fingerprint)
  ) {
    throw new Error('Compiled workspace packages are missing or older than their source.');
  }
  await verifyEntries(root);
  if (record) writeFileSync(path, JSON.stringify({ fingerprint }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkWorkspaceBuild(ROOT, process.argv[2] === '--record');
  } catch (error) {
    process.stderr.write(
      `${error.message} Run pnpm rebuild:workspace before starting or building Sahaya.\n`,
    );
    process.exitCode = 1;
  }
}
