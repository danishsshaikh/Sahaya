import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

export const MANIM_VERSION = '0.22.1';
const path = join(process.cwd(), 'skills', 'sahaya-manim');
export const REFERENCE_TOPICS = {
  layout: 'VGroup arrange next_to Create Transform animations object layout',
  plotting: 'Axes plot c2p ParametricFunction functions graphing',
  camera: 'MovingCameraScene ThreeDScene move_camera ThreeDAxes Surface',
  timing: 'CairoRenderer frame timing Scene play wait next_section',
  rendering: 'MathTex syntax latex errors and scene construct animation arguments',
} as const;
export type ReferenceTopic = keyof typeof REFERENCE_TOPICS;

export function isReferenceTopic(value: unknown): value is ReferenceTopic {
  return typeof value === 'string' && Object.hasOwn(REFERENCE_TOPICS, value);
}

/** Discovery and activation are private to the visualization task. */
export async function discoverManimSkill() {
  const file = await readFile(join(path, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/.exec(file);
  if (!match || file.length > 8192) throw new Error('Invalid builtin Manim skill');
  const metadata = load(match[1]) as {
    name?: unknown;
    description?: unknown;
    metadata?: { version?: unknown };
  };
  if (
    metadata?.name !== 'sahaya-manim' ||
    typeof metadata.description !== 'string' ||
    typeof metadata.metadata?.version !== 'string'
  )
    throw new Error('Invalid builtin Manim skill metadata');
  return {
    name: metadata.name,
    description: metadata.description,
    version: metadata.metadata.version,
    activate: () => match[2].trim(),
  };
}

export function relevantReferences(context: string): ReferenceTopic[] {
  const selected: ReferenceTopic[] = ['layout', 'timing'];
  if (/plot|equation|math|physic|diffraction|gradient|trajectory|function|curve/i.test(context))
    selected.push('plotting');
  if (/\b3d\b|spatial|surface|camera/i.test(context)) selected.push('camera');
  if (/equation|formula|latex|mathtex/i.test(context)) selected.push('rendering');
  return selected;
}

export function readManimReference(topic: ReferenceTopic) {
  if (!isReferenceTopic(topic)) throw new Error('Unknown Manim reference');
  return readFile(join(path, 'references', `${topic}.md`), 'utf8');
}
