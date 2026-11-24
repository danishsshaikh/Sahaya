import type { VisualizationContent } from '@openmaic/dsl';

type Cue = VisualizationContent['artifact']['cues'][number];

export function visualizationCueAt(cues: Cue[], time: number): Cue | undefined {
  return cues.find((cue) => time >= cue.start && time < cue.end);
}

/** Map video time to spoken seconds while allowing a visual beat to breathe. */
export function visualizationCueTiming(
  cue: Cue,
  time: number,
  audioSeconds: number,
  speed: number,
) {
  const videoSeconds = cue.end - cue.start;
  const ratio = Math.max(1, audioSeconds / videoSeconds);
  const offset = Math.max(0, (time - cue.start) * ratio);
  return { offset, rate: speed / ratio };
}
