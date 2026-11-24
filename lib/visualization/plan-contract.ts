import schema from '@/services/manim-renderer/plan-v1.json';

export type Plan = Record<string, unknown>;
export type PlanPath = (string | number)[];
export interface PlanIssue {
  path: PlanPath;
  code: string;
  message: string;
  value?: unknown;
  limit?: number;
  allowed?: unknown;
  phase?: string;
}

const contract = schema['x-contract'];
const owned = new Set<string>(contract.owned);
const protectedFields = new Set(['model', 'expression', 'yExpression', 'source', 'component']);
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const objectAliases: Readonly<Record<string, string>> = contract.objectAliases;
const objects: Readonly<Record<string, { fields: string[]; required?: string[] }>> =
  contract.objects;
const plots = new Set(['graph', 'curve', 'samples', 'samples3d', 'surface']);
const { object, animation, ...definitions } = schema.$defs;
const { kind: _kind, ...objectFields } = object.properties;
const { op: _op, ...animationFields } = animation.properties;
const planFields = Object.fromEntries(
  Object.entries(schema.properties).filter(([key]) => !owned.has(key)),
);
const fixedMetadata = Object.fromEntries(
  Object.entries(schema.properties)
    .filter(([key, field]) => owned.has(key) && 'const' in field)
    .map(([key, field]) => [key, 'const' in field ? field.const : undefined]),
);

export const PLAN_GUIDANCE = `
Return the plan fields, without version/type/engine (Sahaya sets them). Required: ${schema.required.filter((key) => !owned.has(key)).join(', ')}.
Machine-readable fields and bounds (references address "defs"):
${JSON.stringify({ plan: planFields, defs: definitions, objectFields, animationFields })}
For each object use id, kind, optional color/opacity/at, and only the kind-specific fields below. Plots use their axes for positioning and accept neither at nor size.
${Object.entries(contract.objects)
  .map(
    ([kind, spec]) =>
      `${kind}: ${spec.fields.join(', ') || 'no additional fields'}${'required' in spec ? ` (required: ${spec.required.join(', ')})` : ''}${'size' in spec ? `; size = ${spec.size}` : ''}${'hint' in spec ? `. ${spec.hint}` : ''}`,
  )
  .join('\n')}
Size range is ${objectFields.size.minimum}–${objectFields.size.maximum}. ${objectFields.size.description} Omit size for kinds with no listed size meaning.
Axes/plane/axes3d ranges accept [min,max] or [min,max,tickStep] (positive step, at most ${contract.limits.axisIntervals} intervals); plot domains are [min,max] only. Omit axis ranges for the usual renderer defaults. Declare axes before plots and use exact IDs in references.
Canvas coordinates are [x,y] with y within ±${contract.limits.verticalCanvas}. Leave safe margins and use ranges covering every plotted sample.
Executable expressions accept numbers, x (and y for surfaces), + - * / ^, pi, e, and ${contract.expressionFunctions.join(', ')}. Use explicit multiplication and no TeX in expressions. ${contract.expressionHint}
Display equations use equation.text. Return bare math, no dollar delimiters, environments, custom macros or text wrappers. Write two backslashes in JSON for each TeX backslash, for example {"kind":"equation","text":"a\\\\sin(\\\\theta)=m\\\\lambda"}. Allowed TeX commands: ${contract.texCommands.join(', ')}. Plain-language labels go in text objects.
Scientific model sources: ${JSON.stringify(contract.modelHints)}
For a concept without a supported model, use a clearly labeled illustrative composition or a valid plot expression for the actual mathematics. Describe illustrative diagrams as illustrative in the narration or visible text. Do not invent model kinds or parameters.
Each operation requires op and object. Additional required arguments: ${JSON.stringify(contract.animationArguments)}. Rotate uses degrees. Scale factor range: ${contract.scaleRange.join('–')}.
Create, write and fadeIn introduce hidden objects, other operations act on visible ones. Replace needs a hidden target. Follow needs a graph, curve, line or arrow. No parallel operations may share an object. A camera transition occupies a beat of its own. Omit animations for a wait. At most ${contract.limits.operations} operations and a weighted complexity budget of ${contract.limits.complexity}.
`;

function isRecord(value: unknown): value is Plan {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Accept JSON or one complete JSON fence. Never salvage values from truncated JSON. */
export function parsePlanObject(response: string): Plan | undefined {
  if (response.length > 88_000) return undefined;
  const text = response.trim();
  const fence = /^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i.exec(text);
  try {
    const value: unknown = JSON.parse(fence?.[1] ?? text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function coordinates(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 3 && value[2] === 0) return value.slice(0, 2);
  if (
    isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    Object.keys(value).every((key) => key === 'x' || key === 'y' || (key === 'z' && value.z === 0))
  )
    return [value.x, value.y];
  return value;
}

const mathSymbols: Readonly<Record<string, string>> = {
  λ: 'lambda',
  θ: 'theta',
  π: 'pi',
  φ: 'phi',
  α: 'alpha',
  β: 'beta',
  Δ: 'Delta',
  δ: 'delta',
  '×': 'times',
  '·': 'cdot',
  '±': 'pm',
  '≤': 'le',
  '≥': 'ge',
  '≈': 'approx',
};

function formatEquation(value: string): string {
  const input = value.trim();
  const wrapper = /^(?:\$\$([^$]+)\$\$|\$([^$]+)\$|\\\(([\s\S]+)\\\)|\\\[([\s\S]+)\\\])$/.exec(
    input,
  );
  return (wrapper?.slice(1).find((part) => part !== undefined) ?? input)
    .trim()
    .replace(/\\(?:dfrac|tfrac|leq|geq)(?![A-Za-z])/g, (command) => {
      const equivalent: Record<string, string> = {
        dfrac: 'frac',
        tfrac: 'frac',
        leq: 'le',
        geq: 'ge',
      };
      return `\\${equivalent[command.slice(1)]}`;
    })
    .replace(/[λθπφαβΔδ×·±≤≥≈−]/g, (symbol) => (symbol === '−' ? '-' : `\\${mathSymbols[symbol]} `))
    .trim();
}

/** Normalize only equivalent encodings. Leave unknown or conflicting inputs for the renderer. */
export function compilePlan(draft: Plan): { plan: Plan; actions: string[] } {
  const actions = new Set<string>();
  const plan = { ...draft, ...fixedMetadata };
  if (Object.keys(fixedMetadata).some((key) => draft[key] !== fixedMetadata[key]))
    actions.add('setMetadata');
  const set = (entry: Plan, key: string, value: unknown, action: string) => {
    if (entry[key] !== value) {
      entry[key] = value;
      actions.add(action);
    }
  };
  const rename = (entry: Plan, from: string, to: string) => {
    if (Object.hasOwn(entry, from) && !Object.hasOwn(entry, to)) {
      set(entry, to, entry[from], 'normalizeField');
      delete entry[from];
    }
  };

  if (Array.isArray(plan.objects)) {
    // Reserve both existing IDs and explicit references. Never make a broken
    // reference resolve by guessing which unnamed object it denotes.
    const ids = new Set<unknown>();
    for (const entry of plan.objects) {
      if (isRecord(entry)) {
        ids.add(entry.id);
        ids.add(entry.axes);
      }
    }
    if (Array.isArray(plan.timeline)) {
      for (const beat of plan.timeline) {
        if (!isRecord(beat) || !Array.isArray(beat.animations)) continue;
        for (const op of beat.animations) {
          if (!isRecord(op)) continue;
          ids.add(op.object);
          ids.add(op.target);
        }
      }
    }
    plan.objects = plan.objects.map((entry, index) => {
      if (!isRecord(entry)) return entry;
      const obj = { ...entry };
      if (typeof obj.kind !== 'string') return obj;
      if (Object.hasOwn(objectAliases, obj.kind))
        set(obj, 'kind', objectAliases[obj.kind], 'normalizeKind');
      const kind = obj.kind as string;
      if (!Object.hasOwn(objects, kind)) return obj;
      if (!Object.hasOwn(obj, 'id')) {
        let id = `object-${index + 1}`;
        while (ids.has(id)) id += 'a';
        if (id.length <= 32) {
          set(obj, 'id', id, 'assignId');
          ids.add(id);
        }
      }
      if (!plots.has(kind)) rename(obj, 'position', 'at');
      for (const [alias, field] of [
        ['x_range', 'xRange'],
        ['y_range', 'yRange'],
        ['z_range', 'zRange'],
      ]) {
        if (objects[kind].fields.includes(field)) rename(obj, alias, field);
      }
      if (Object.hasOwn(obj, 'at')) set(obj, 'at', coordinates(obj.at), 'normalizeCoordinates');
      if (Array.isArray(obj.points)) {
        const points = obj.points.map(coordinates);
        if (points.some((point, offset) => point !== (obj.points as unknown[])[offset]))
          set(obj, 'points', points, 'normalizeCoordinates');
      }
      if (kind === 'equation' && typeof obj.text === 'string')
        set(obj, 'text', formatEquation(obj.text), 'normalizeEquation');
      return obj;
    });
  }
  if (Array.isArray(plan.timeline)) {
    plan.timeline = plan.timeline.map((beat) => {
      if (!isRecord(beat) || !Array.isArray(beat.animations)) return beat;
      return {
        ...beat,
        animations: beat.animations.map((entry) => {
          if (!isRecord(entry)) return entry;
          const op = { ...entry };
          if (op.op === 'rotate') rename(op, 'degrees', 'value');
          if (op.op === 'scale') rename(op, 'factor', 'value');
          if (op.op === 'move') {
            rename(op, 'position', 'to');
            if (Object.hasOwn(op, 'to')) set(op, 'to', coordinates(op.to), 'normalizeCoordinates');
          }
          return op;
        }),
      };
    });
  }
  return { plan, actions: [...actions] };
}

export function normalizePlan(plan: Plan): Plan {
  return compilePlan(plan).plan;
}

export function operatorIssueLocation(path: PlanPath): string {
  return path
    .map((key) =>
      typeof key === 'number' ||
      (/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(key) &&
        !/^(?:sk[-_]|ghp_|github_pat_|AKIA)/i.test(key))
        ? key
        : '[invalid field name]',
    )
    .join('.');
}

export function facultyIssueLocation(path: PlanPath): string {
  // Use only schema field names and numeric indices. Unknown keys can contain private text.
  const keys = new Set([
    ...Object.keys(planFields),
    ...Object.keys(objectFields),
    ...Object.keys(animationFields),
    ...schema.properties.model.oneOf.flatMap((model) => Object.keys(model.properties)),
    'id',
    'kind',
    'op',
    'animations',
    'narration',
    'caption',
    'seconds',
    'phi',
    'theta',
  ]);
  return path
    .map((key) => (typeof key === 'number' || keys.has(key) ? key : '[unsupported field]'))
    .join('.');
}

export function repairableIssue(issue: PlanIssue): boolean {
  return (
    issue.path.length > 0 &&
    !owned.has(String(issue.path[0])) &&
    (issue.path[0] !== 'model' || issue.code === 'unsupportedField') &&
    !(issue.path[0] === 'objects' && issue.path.length === 2) &&
    !issue.path.some(
      (key) =>
        typeof key === 'string' &&
        (unsafeKeys.has(key) || (protectedFields.has(key) && issue.code !== 'unsupportedField')),
    ) &&
    !(
      issue.path.length === 1 &&
      ['objects', 'timeline'].includes(String(issue.path[0])) &&
      issue.code !== 'required'
    )
  );
}

function equationTokens(text: string) {
  // Sizing commands affect presentation. Keep every delimiter, operator,
  // control sequence, group and operand in the equivalence check.
  return formatEquation(text)
    .match(/\\[A-Za-z]+|\S/g)
    ?.filter((token) => token !== '\\left' && token !== '\\right')
    .join(' ');
}

function safePatchValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((entry) => safePatchValue(entry, depth + 1));
  if (isRecord(value))
    return Object.entries(value).every(
      ([key, entry]) => !unsafeKeys.has(key) && safePatchValue(entry, depth + 1),
    );
  return true;
}

function replaceInvalidObject(
  previous: unknown,
  next: unknown,
  issues: PlanIssue[],
  index: number,
) {
  if (!isRecord(previous) || !isRecord(next) || typeof next.kind !== 'string') return false;
  const kind = Object.hasOwn(objectAliases, next.kind) ? objectAliases[next.kind] : next.kind;
  if (!Object.hasOwn(objects, kind) || next.id !== previous.id) return false;
  const spec = objects[kind];
  const allowed = new Set(['id', 'kind', 'color', 'opacity', ...spec.fields]);
  if (!plots.has(kind)) {
    allowed.add('at');
    allowed.add('size');
  }
  if (Object.keys(next).some((field) => !allowed.has(field))) return false;
  if (spec.required?.some((field) => !Object.hasOwn(next, field))) return false;
  for (const field of [...protectedFields, 'text']) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) return false;
  }
  return Object.entries(previous).every(
    ([field, value]) =>
      field === 'kind' ||
      !allowed.has(field) ||
      JSON.stringify(next[field]) === JSON.stringify(value) ||
      issues.some(
        (issue) =>
          repairableIssue(issue) &&
          JSON.stringify(issue.path) === JSON.stringify(['objects', index, field]),
      ),
  );
}

/** Apply exact field edits or replace a complete invalid kind transactionally. */
export function applyPlanRepair(plan: Plan, proposal: Plan, issues: PlanIssue[]): Plan | undefined {
  if (
    Object.keys(proposal).length !== 1 ||
    !Array.isArray(proposal.edits) ||
    proposal.edits.length === 0 ||
    proposal.edits.length > 24
  )
    return undefined;
  const proposed = structuredClone(plan);
  const edited: PlanPath[] = [];
  for (const edit of proposal.edits) {
    if (!isRecord(edit) || !Array.isArray(edit.path)) return undefined;
    const path = edit.path as PlanPath;
    const fingerprint = JSON.stringify(path);
    if (
      edited.some((prior) => {
        const length = Math.min(path.length, prior.length);
        return path.slice(0, length).every((key, index) => key === prior[index]);
      }) ||
      !safePatchValue(edit.value)
    )
      return undefined;
    edited.push(path);
    if (
      path.length === 2 &&
      path[0] === 'objects' &&
      typeof path[1] === 'number' &&
      issues.some(
        (issue) =>
          issue.code === 'enum' && JSON.stringify(issue.path) === JSON.stringify([...path, 'kind']),
      )
    ) {
      if (
        !Array.isArray(proposed.objects) ||
        edit.op !== 'replace' ||
        Object.keys(edit).length !== 3 ||
        !replaceInvalidObject(proposed.objects[path[1]], edit.value, issues, path[1])
      )
        return undefined;
      proposed.objects[path[1]] = edit.value;
      continue;
    }
    const issue = issues.find(
      (entry) => repairableIssue(entry) && JSON.stringify(entry.path) === fingerprint,
    );
    if (!issue || (path[0] === 'objects' && path[2] === 'kind' && issue.code === 'enum'))
      return undefined;
    const remove = issue.code === 'unsupportedField';
    if (
      remove
        ? edit.op !== 'remove' || Object.keys(edit).length !== 2
        : edit.op !== (issue.code === 'required' ? 'add' : 'replace') ||
          Object.keys(edit).length !== 3 ||
          !Object.hasOwn(edit, 'value')
    )
      return undefined;
    let parent: unknown = proposed;
    for (const key of path.slice(0, -1)) {
      if (isRecord(parent) && typeof key === 'string' && Object.hasOwn(parent, key))
        parent = parent[key];
      else if (Array.isArray(parent) && typeof key === 'number' && key >= 0 && key < parent.length)
        parent = parent[key];
      else return undefined;
    }
    const key = path[path.length - 1];
    if (
      Array.isArray(parent) &&
      typeof key === 'number' &&
      key >= 0 &&
      key < parent.length &&
      !remove &&
      edit.op === 'replace'
    ) {
      parent[key] = edit.value;
    } else if (isRecord(parent) && typeof key === 'string') {
      if (Object.hasOwn(parent, key) === (edit.op === 'add')) return undefined;
      if (
        parent.kind === 'equation' &&
        key === 'text' &&
        typeof parent.text === 'string' &&
        (typeof edit.value !== 'string' ||
          equationTokens(parent.text) !== equationTokens(edit.value))
      )
        return undefined;
      if (remove) delete parent[key];
      else parent[key] = edit.value;
    } else return undefined;
  }
  return proposed;
}
