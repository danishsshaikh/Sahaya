import { describe, expect, it } from 'vitest';
import { finalizeFirstSceneVisual } from '@/lib/generation/first-scene-lifecycle';

describe('first scene visual lifecycle', () => {
  it('commits, persists, and exposes the visual before starting narration', async () => {
    const events: string[] = [];
    const narration = Promise.withResolvers<void>();

    await finalizeFirstSceneVisual({
      commitVisual: () => events.push('visual-committed'),
      persistVisual: async () => {
        events.push('visual-persisted');
      },
      navigateToClassroom: () => events.push('classroom-visible'),
      scheduleNarration: () => {
        events.push('narration-started');
        void narration.promise.then(() => events.push('narration-completed'));
      },
    });

    expect(events).toEqual([
      'visual-committed',
      'visual-persisted',
      'classroom-visible',
      'narration-started',
    ]);
    narration.resolve();
    await narration.promise;
  });
});
