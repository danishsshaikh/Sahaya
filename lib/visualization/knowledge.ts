import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIM_VERSION } from './skill';

type Definition = { signature: string; doc: string; keywords: string[] };
type Class = { name: string; bases: string[]; doc: string; methods: Record<string, Definition> };
type Index = {
  version: string;
  exports: Record<string, string>;
  classes: Record<string, Class>;
  functions: Record<string, Definition>;
  constants: Record<string, { value: string }>;
  documents: { path: string; text?: string }[];
};
type Example = {
  id: string;
  title: string;
  concepts?: string[];
  symbols: string[];
  source: string;
};
export type ApiEntry = { symbol: string; signature: string; doc?: string; bases?: string[] };
export type Knowledge = {
  version: string;
  entries: ApiEntry[];
  examples: { id: string; excerpt: string }[];
  notes: string[];
};

const rules: [RegExp, string[]][] = [
  [
    /number[ _-]?line|n2p|number.to.point|tick marks/,
    ['NumberLine', 'NumberLine.n2p', 'NumberLine.number_to_point', 'Mobject.move_to'],
  ],
  [
    /axes|plot|function|graph|curve|diffraction|interference|wave/,
    ['Axes', 'Axes.plot', 'Axes.c2p', 'ParametricFunction'],
  ],
  [
    /wave|oscillat|diffraction|interference|tracker|updat|motion|acceleration|orbit/,
    [
      'ValueTracker',
      'ValueTracker.get_value',
      'ValueTracker.set_value',
      'always_redraw',
      'Mobject.add_updater',
      'Mobject.remove_updater',
    ],
  ],
  [
    /matri|linear algebra|eigen|basis/,
    ['Matrix', 'Matrix.get_columns', 'SurroundingRectangle', 'Arrow'],
  ],
  [/probab|histogram|distribution|statistic|frequency/, ['BarChart', 'SampleSpace']],
  [
    /3d|surface|spatial/,
    ['ThreeDAxes', 'ThreeDScene.set_camera_orientation', 'ThreeDScene.move_camera', 'Surface'],
  ],
  [/camera|zoom/, ['MovingCameraScene', 'MovingCamera', 'ThreeDScene.move_camera']],
  [/formula|equation|latex|mathtex|label/, ['MathTex', 'Text', 'Mobject.next_to']],
  [/vector|arrow|geometry/, ['Arrow', 'Vector', 'VGroup']],
];
const fallback = ['Create', 'Transform', 'VGroup', 'Scene.play'];
let cached: Promise<{ index: Index; examples: Example[] }> | undefined;

export function validateKnowledgeVersion(version: string) {
  if (version !== MANIM_VERSION) throw new Error('Manim API index version mismatch');
}

export function loadManimKnowledge() {
  if (!cached)
    cached = (async () => {
      const directory = join(process.cwd(), 'skills/sahaya-manim/examples');
      const [raw, manifest] = await Promise.all([
        readFile(join(process.cwd(), 'services/manim-renderer/manim_api.json'), 'utf8'),
        readFile(join(directory, 'manifest.json'), 'utf8'),
      ]);
      const index = JSON.parse(raw) as Index;
      validateKnowledgeVersion(index.version);
      const examples = await Promise.all(
        (JSON.parse(manifest) as Omit<Example, 'source'>[]).map(async (entry) => ({
          ...entry,
          source: await readFile(join(directory, `${entry.id}.py`), 'utf8'),
        })),
      );
      return { index, examples };
    })().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

function resolveMethod(index: Index, key: string, method: string): Definition | undefined {
  const pending = [key];
  const seen = new Set<string>();
  for (const item of pending) {
    if (seen.has(item)) continue;
    seen.add(item);
    const cls = index.classes[item];
    if (!cls) continue;
    if (Object.hasOwn(cls.methods, method)) return cls.methods[method];
    pending.push(...cls.bases);
  }
}

function getEntry(index: Index, symbol: string, detailed = false): ApiEntry | undefined {
  const [name, member] = symbol.split('.');
  const key = index.exports[name];
  if (!Object.hasOwn(index.exports, name) || !key) return undefined;
  const cls = index.classes[key];
  if (cls) {
    const signature = resolveMethod(index, key, member || '__init__');
    if (member && !signature) return undefined;
    const doc = member ? signature?.doc : cls.doc;
    return {
      symbol,
      signature: symbol + (signature?.signature.replace(/^\((?:self|cls),?\s*/, '(') ?? ''),
      ...(!member && { bases: cls.bases.map((base) => base.split('.').at(-1) ?? base) }),
      doc: detailed
        ? doc?.slice(0, 900)
        : doc
            ?.split(/\n\s*\n/)[0]
            ?.replace(/\s+/g, ' ')
            .slice(0, 145),
    };
  }
  if (member) return undefined;
  const func = index.functions[key];
  if (func)
    return {
      symbol,
      signature: symbol + func.signature,
      doc: detailed ? func.doc.slice(0, 900) : func.doc.split('\n')[0]?.slice(0, 145),
    };
  const constant = index.constants[key];
  if (constant) return { symbol, signature: `${symbol} = ${constant.value}` };
}

const tokens = (text: string) => text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [];

function exampleExcerpt(source: string) {
  // The bundled examples also run as standalone files. Show their authored
  // Python in the same format the model is asked to use.
  const wrapper =
    /^from sahaya_timing import (CueScene|CueMovingCameraScene|CueThreeDScene)\n\nclass GeneratedScene\(\1\):\n    def construct\(self\):\n/m.exec(
      source,
    );
  if (wrapper) {
    const mode =
      wrapper[1] === 'CueScene'
        ? 'standard'
        : wrapper[1] === 'CueMovingCameraScene'
          ? 'moving-camera'
          : 'three-d';
    const firstLine = source.indexOf('\n');
    source = `${source.slice(0, firstLine + 1)}# sahaya-scene: ${mode}\n${source.slice(firstLine + 1, wrapper.index)}def animate(self):\n${source.slice(wrapper.index + wrapper[0].length).replace(/^ {4}/gm, '')}`;
  }
  return source.length <= 720 ? source : source.slice(0, 720).replace(/\n[^\n]*$/, '\n');
}
export type Lookup = {
  query: string;
  kind: 'search' | 'class' | 'constructor' | 'method' | 'examples' | 'alternatives';
};

export async function retrieveManimKnowledge(
  task: string,
  lookup?: Lookup,
  repairs: string[] = [],
  focus = task,
): Promise<Knowledge> {
  const { index, examples } = await loadManimKnowledge();
  const text = (lookup?.query ?? task).slice(0, 6000);
  const words = new Set(tokens(text));
  const focusWords = new Set(tokens((lookup?.query ?? focus).slice(0, 6000)));
  const direct = [...new Set(text.match(/\b[A-Za-z]\w*(?:\.[A-Za-z]\w*)?/g) ?? [])]
    .filter((item) => getEntry(index, item))
    .slice(0, 8);
  // Interleave concept groups so one long category doesn't crowd out an
  // independent concept such as plotting plus tracker updates.
  const groups = rules
    .filter(([pattern]) => pattern.test(text.toLowerCase()))
    .map(([, entries]) => entries);
  const relevant = Array.from(
    { length: Math.max(0, ...groups.map((group) => group.length)) },
    (_, position) => groups.flatMap((group) => (group[position] ? [group[position]] : [])),
  ).flat();
  const ranked = Object.keys(index.exports)
    .map((name) => ({
      name,
      score: words.has(name.toLowerCase())
        ? 5
        : tokens(name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')).filter((word) =>
            words.has(word),
          ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ name }) => name);
  const entrySet = new Set([...repairs, ...direct, ...relevant, ...ranked, ...fallback]);
  if (lookup?.kind === 'alternatives') {
    const className = text.split('.')[0];
    const methods = index.classes[index.exports[className]]?.methods;
    for (const name of Object.keys(methods ?? {})
      .filter((key) => !key.startsWith('_'))
      .slice(0, 8))
      entrySet.add(`${className}.${name}`);
  }
  const entries =
    lookup?.kind === 'examples'
      ? []
      : [...entrySet]
          .flatMap((id) => {
            const item = getEntry(index, id, !!lookup && direct.includes(id));
            if (!item) return [];
            // Keep the complete requested signature when looking up an exact API.
            return [
              {
                ...item,
                signature: item.signature.slice(0, lookup || repairs.includes(id) ? 1600 : 800),
              },
            ];
          })
          .slice(0, lookup ? 10 : 11);
  const best = examples
    .map((entry) => ({
      entry,
      focusMatches: (entry.concepts ?? []).filter((word) => focusWords.has(word)).length,
      conceptMatches: (entry.concepts ?? []).filter((word) => words.has(word)).length,
      score:
        entry.symbols.reduce((score, name) => score + (entrySet.has(name) ? 2 : 0), 0) +
        tokens(entry.title).filter((word) => words.has(word)).length * 3,
    }))
    .filter(({ focusMatches, conceptMatches, score }) => focusMatches || conceptMatches || score)
    .sort(
      (a, b) =>
        b.focusMatches - a.focusMatches ||
        b.conceptMatches - a.conceptMatches ||
        b.score - a.score ||
        a.entry.id.localeCompare(b.entry.id),
    );
  const selected = best.slice(0, 2).map(({ entry }) => ({
    id: entry.id,
    excerpt: exampleExcerpt(entry.source),
  }));
  const notes = /cairo|opengl|renderer|3d|camera/.test(text.toLowerCase())
    ? index.documents
        .filter((entry) => entry.text?.includes('Cairo'))
        .slice(0, 2)
        .map((entry) => `${entry.path}: ${entry.text}`)
    : [];
  return { version: index.version, entries, examples: selected, notes };
}
