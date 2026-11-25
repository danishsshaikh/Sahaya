export const VISUALIZATION_FAILURES = {
  VISUALIZATION_PLANNING:
    'The AI could not create a complete Manim scene. Retry this scene or simplify its animation instructions.',
  VISUALIZATION_SCHEMA:
    'The animation source or timing metadata failed validation. Review its instructions and retry this scene.',
  VISUALIZATION_REPAIR:
    'The AI could not correct the Manim scene. Retry this scene with fewer objects or simpler animation instructions.',
  VISUALIZATION_DOCUMENTATION_BUDGET:
    'The AI kept requesting Manim references after reference retrieval closed and never submitted Python.',
  VISUALIZATION_PYTHON_MISSING:
    'The AI did not submit a complete Manim Python scene. Retry or simplify the animation instructions.',
  VISUALIZATION_PYTHON_VALIDATION:
    'The submitted Manim Python or cue metadata failed validation. Review the scene instructions and retry.',
  VISUALIZATION_MODEL_TIMEOUT:
    'The AI model exceeded its time limit while generating the Manim scene.',
  VISUALIZATION_MODEL_OUTPUT_LIMIT:
    'The AI model used its completion budget before returning a complete Manim scene.',
  VISUALIZATION_MODEL_UNAVAILABLE:
    'The configured AI model or provider could not complete the Manim request. Try again shortly.',
  VISUALIZATION_UNAVAILABLE:
    'Secure Manim execution is unavailable. Check the publisher and sandbox readiness or try again shortly.',
  VISUALIZATION_RENDER:
    'The renderer could not finish the animation. Retry this scene with simpler graphics or equations.',
  VISUALIZATION_RENDER_TIMEOUT:
    'The visualization exceeded its rendering time limit. Retry this scene with a shorter or simpler animation.',
  VISUALIZATION_ARTIFACT_VALIDATION:
    'Manim returned media that failed artifact validation. Retry this scene.',
  VISUALIZATION_DEADLINE:
    'The Manim agent reached its overall deadline. Retry this scene with simpler animation instructions.',
  VISUALIZATION_PREPARATION:
    'The Manim agent could not load its scene authoring resources. Try again shortly.',
  VISUALIZATION_NARRATION_SYNC:
    'The animation was rendered, but its timing could not be updated for Teaching Voice. Playback can pace the existing video with your narration.',
} as const;

export type VisualizationFailureCode = keyof typeof VISUALIZATION_FAILURES;

export function isVisualizationFailure(code: unknown): code is VisualizationFailureCode {
  return typeof code === 'string' && Object.hasOwn(VISUALIZATION_FAILURES, code);
}

export class VisualizationFailure extends Error {
  // The agent has already applied its retry and deadline policy.
  readonly isRetryable = false;

  constructor(
    readonly code: VisualizationFailureCode,
    readonly detail?: string,
  ) {
    super(detail ? `${VISUALIZATION_FAILURES[code]} (${detail})` : VISUALIZATION_FAILURES[code]);
  }
}
