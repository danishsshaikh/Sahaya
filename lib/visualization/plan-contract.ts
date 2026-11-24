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
}

const contract = schema['x-contract'];
const owned = new Set<string>(contract.owned);
const protectedFields = new Set(['model', 'expression', 'yExpression', 'source', 'component']);
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
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
Canvas y must stay within ±${contract.limits.verticalCanvas}. Leave safe margins and use ranges covering every plotted sample.
Expressions accept numbers, x (and y for surfaces), + - * / ^, pi, e, and ${contract.expressionFunctions.join(', ')}. Use explicit multiplication. ${contract.expressionHint}
Allowed TeX commands: ${contract.texCommands.join(', ')}.
Scientific model sources: ${JSON.stringify(contract.modelHints)}
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

export function normalizePlan(plan: Plan): Plan {
  return { ...plan, ...fixedMetadata };
}

export function facultyIssueLocation(path: PlanPath): string {
  // Use only schema field names and numeric indices. Unknown keys can contain private text.
  const keys = new Set([
    ...Object.keys(planFields),
    ...Object.keys(objectFields),
    ...Object.keys(animationFields),
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

/** Apply only exact issue paths, transactionally. Revalidate the entire result before admission. */
export function applyPlanRepair(plan: Plan, proposal: Plan, issues: PlanIssue[]): Plan | undefined {
  if (
    Object.keys(proposal).length !== 1 ||
    !Array.isArray(proposal.edits) ||
    proposal.edits.length === 0 ||
    proposal.edits.length > 12
  )
    return undefined;
  const proposed = structuredClone(plan);
  const edited = new Set<string>();
  for (const edit of proposal.edits) {
    if (!isRecord(edit) || !Array.isArray(edit.path)) return undefined;
    const path = edit.path as PlanPath;
    const fingerprint = JSON.stringify(path);
    const issue = issues.find(
      (entry) => repairableIssue(entry) && JSON.stringify(entry.path) === fingerprint,
    );
    if (!issue || edited.has(fingerprint)) return undefined;
    edited.add(fingerprint);
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
      if (remove) delete parent[key];
      else parent[key] = edit.value;
    } else return undefined;
  }
  return proposed;
}
