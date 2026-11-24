import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compilePlan, parsePlanObject } from '@/lib/visualization/plan-contract';

function beat(object: string, narration: string) {
  return { seconds: 1, narration, animations: [{ op: 'create', object }] };
}

// Synthetic provider-shaped drafts. These are independent of the missing live HPC payloads.
const intensityAxes = {
  id: 'a',
  kind: 'Axes',
  x_range: [-3, 3, 1],
  y_range: [0, 1.2, 0.2],
  position: { x: 0, y: -0.5 },
  size: 9,
  height: 4,
};
const drafts = [
  {
    title: 'Single-slit intensity and minima',
    objective: 'Locate the minima of a uniform slit in the far field',
    objects: [
      intensityAxes,
      { id: 'curve', kind: 'graph', axes: 'a', expression: 'sinc(pi*x)^2' },
      { id: 'equation', kind: 'MathTex', text: '$a\\sin(θ)=mλ$', position: [0, 2.7, 0] },
    ],
    timeline: [
      beat('a', 'Distance along the horizontal axis is normalized.'),
      beat('curve', 'The curve vanishes at nonzero integers.'),
      beat(
        'equation',
        'The first dark fringes occur when the path difference equals one wavelength.',
      ),
    ],
  },
  {
    title: 'Single-slit aperture geometry',
    objective: 'Show where the path difference comes from',
    objects: [
      {
        id: 'edge',
        kind: 'Line',
        points: [
          { x: -3, y: -1 },
          { x: -3, y: 1 },
        ],
      },
      {
        id: 'ray',
        kind: 'Arrow',
        points: [
          [-3, 1, 0],
          [3, 2, 0],
        ],
      },
      { id: 'distance', kind: 'MathTex', text: '$Δ=a\\sin(θ)$', at: [1, -2] },
    ],
    timeline: [
      beat('edge', 'The vertical segment represents the slit width.'),
      beat('ray', 'In the far field the rays toward a common point are nearly parallel.'),
      beat('distance', 'Project the separation along the observation direction.'),
    ],
  },
  {
    title: 'Single-slit central peak zoom',
    objective: 'Compare center intensity with the half-order intensity',
    objects: [
      { ...intensityAxes, x_range: [-1, 1, 0.5] },
      { id: 'g', kind: 'graph', axes: 'a', expression: 'sinc(pi*x)^2' },
      { id: 'd', kind: 'Dot', position: { x: 0, y: 0, z: 0 }, color: '#FFD079' },
    ],
    timeline: [
      beat('a', 'Focus on the central peak.'),
      beat('g', 'The two adjacent zeros bound the bright region.'),
      beat('d', 'This marker can move across the diagram.'),
      { seconds: 1, animations: [{ op: 'move', object: 'd', position: [1, 1, 0] }] },
    ],
  },
  {
    title: 'Five narrow slits',
    objective: 'Explain why a larger number of slits sharpens principal maxima',
    objects: [
      intensityAxes,
      { id: 'g', kind: 'graph', axes: 'a', expression: '((1+2*cos(2*pi*x)+2*cos(4*pi*x))/5)^2' },
      { id: 'grating', kind: 'MathTex', text: '$d\\sin(θ)=mλ$', at: [0, 2.7, 0] },
    ],
    timeline: [
      beat('a', 'Assume five identical, narrow and equally spaced slits.'),
      beat('g', 'Principal orders occur where the terms reinforce.'),
      beat('grating', 'The angle depends on the slit separation.'),
    ],
  },
  {
    title: 'Gradient descent on a convex loss',
    objective: 'Relate step size to the derivative of a quadratic',
    model: { kind: 'gradient_descent', expression: 'x^2', initial: 2, rate: 0.25, iterations: 4 },
    objects: [
      { ...intensityAxes, x_range: [-3, 3, 1], y_range: [0, 9, 3] },
      { id: 'loss', kind: 'graph', axes: 'a', source: 'function' },
      { id: 'steps', kind: 'samples', axes: 'a', source: 'iterations' },
    ],
    timeline: [
      beat('a', 'The horizontal axis is the parameter.'),
      beat('loss', 'The quadratic has one minimum.'),
      beat('steps', 'Each step moves in the direction of decreasing loss.'),
    ],
  },
  {
    title: 'Level-ground projectile',
    objective: 'Explain why the horizontal and vertical motion combine into a parabola',
    model: { kind: 'projectile', speed: 12, angle: 40, gravity: 9.81 },
    objects: [
      { ...intensityAxes, x_range: [0, 16, 4], y_range: [0, 4, 1] },
      { id: 'path', kind: 'graph', axes: 'a', source: 'trajectory' },
      { id: 'gravity', kind: 'Arrow', points: [{ x: 1, y: 2 }, [1, 0, 0]] },
    ],
    timeline: [
      beat('a', 'Distances are in meters and air drag is neglected.'),
      beat('path', 'Vertical acceleration bends the path down.'),
      beat('gravity', 'Gravity points down throughout flight.'),
    ],
  },
  {
    title: 'Sliding CNN kernel',
    objective: 'Explain receptive fields and weight reuse across neighboring positions',
    objects: [
      { id: 'image', kind: 'Rectangle', size: 5, height: 4, position: [-2, 0, 0] },
      {
        id: 'kernel',
        kind: 'Rectangle',
        size: 1,
        height: 1,
        position: [-3, 1, 0],
        color: '#FFD079',
      },
      { id: 'map', kind: 'Rectangle', size: 3, height: 2, position: [3, 0, 0] },
    ],
    timeline: [
      beat('image', 'This illustrative diagram shows the input field.'),
      beat('kernel', 'The same filter weights are used at each position.'),
      { seconds: 1, animations: [{ op: 'move', object: 'kernel', position: { x: -2, y: 1 } }] },
      beat('map', 'The response at every position becomes an entry in the feature map.'),
    ],
  },
];

describe('synthetic Manim provider drafts', () => {
  it('compiles seven distinct compositions for authoritative renderer testing', () => {
    const plans = drafts.map((draft) => {
      const parsed = parsePlanObject(JSON.stringify(draft));
      expect(parsed).toBeDefined();
      const { plan, actions } = compilePlan(parsed!);
      expect(actions).toContain('normalizeKind');
      expect(compilePlan(plan).actions).toEqual([]);
      return plan;
    });
    if (process.env.MANIM_COMPILED_FIXTURES_PATH)
      writeFileSync(process.env.MANIM_COMPILED_FIXTURES_PATH, JSON.stringify(plans));
  });
});
