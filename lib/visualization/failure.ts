export const VISUALIZATION_FAILURES = {
  VISUALIZATION_PLANNING:
    'The AI could not create a complete visualization plan. Retry this scene or simplify its animation instructions.',
  VISUALIZATION_SCHEMA:
    'The visualization plan contains unsupported fields, values, or scientific inputs. Review its instructions and retry this scene.',
  VISUALIZATION_REPAIR:
    'The AI could not correct the visualization plan. Retry this scene with fewer objects or simpler animation instructions.',
  VISUALIZATION_UNAVAILABLE:
    'The visualization renderer is unavailable. Check its service configuration or try again shortly.',
  VISUALIZATION_RENDER:
    'The renderer could not finish the animation. Retry this scene with simpler graphics or equations.',
  VISUALIZATION_RENDER_TIMEOUT:
    'The visualization exceeded its rendering time limit. Retry this scene with a shorter or simpler animation.',
  VISUALIZATION_NARRATION_SYNC:
    'The animation was rendered, but its timing could not be updated for Teaching Voice. Playback can pace the existing video with your narration.',
} as const;

export type VisualizationFailureCode = keyof typeof VISUALIZATION_FAILURES;

export function isVisualizationFailure(code: unknown): code is VisualizationFailureCode {
  return typeof code === 'string' && Object.hasOwn(VISUALIZATION_FAILURES, code);
}

export class VisualizationFailure extends Error {
  constructor(
    readonly code: VisualizationFailureCode,
    detail?: string,
  ) {
    super(detail ? `${VISUALIZATION_FAILURES[code]} (${detail})` : VISUALIZATION_FAILURES[code]);
  }
}
