import { describe, expect, it } from 'vitest';
import {
  lessonGenerationEtaLabel,
  lessonGenerationPercent,
  lessonGenerationPhaseLabel,
} from '@/lib/generation/progress';

describe('lesson generation progress display helpers', () => {
  it('keeps progress informational and monotonic across scene phases', () => {
    const content = lessonGenerationPercent({ sceneIndex: 2, totalScenes: 5, phase: 'content' });
    const actions = lessonGenerationPercent({ sceneIndex: 2, totalScenes: 5, phase: 'actions' });
    const narration = lessonGenerationPercent({
      sceneIndex: 2,
      totalScenes: 5,
      phase: 'narration',
    });

    expect(content).toBeGreaterThan(20);
    expect(actions).toBeGreaterThan(content);
    expect(narration).toBeGreaterThan(actions);
    expect(narration).toBeLessThan(100);
  });

  it('uses simple phase labels without provider or model terminology', () => {
    expect(lessonGenerationPhaseLabel('content', 'interactive')).toBe(
      'Building interactive simulation...',
    );
    expect(lessonGenerationPhaseLabel('content', 'quiz')).toBe('Building quiz...');
    expect(lessonGenerationPhaseLabel('narration')).toBe('Creating voice narration...');
  });

  it('does not fabricate an ETA before completed scene timing exists', () => {
    expect(
      lessonGenerationEtaLabel({
        completedSceneDurationsMs: [],
        currentSceneElapsedMs: 5000,
        sceneIndex: 1,
        totalScenes: 5,
      }),
    ).toBe('Estimating time...');
  });

  it('derives a coarse ETA from completed scene durations', () => {
    expect(
      lessonGenerationEtaLabel({
        completedSceneDurationsMs: [90000, 120000],
        currentSceneElapsedMs: 30000,
        sceneIndex: 3,
        totalScenes: 5,
      }),
    ).toMatch(/remaining$/);
  });
});
