import { describe, expect, it } from 'vitest';
import {
  mergeCompletedNarration,
  narrationFailurePatch,
  narrationProgressPatch,
  sceneForNarrationSynthesis,
  sceneWithPendingNarration,
} from '@/lib/generation/scene-narration';
import type { Scene } from '@/lib/types/stage';

function makeScene(text = 'Original narration'): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    title: 'Renderable slide',
    order: 1,
    type: 'slide',
    content: {
      type: 'slide',
      schemaVersion: 1,
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [{ id: 'speech-1', type: 'speech', text }],
  };
}

describe('scene narration lifecycle', () => {
  it.each(['queued', 'running'] as const)(
    'keeps visual content renderable while narration is %s',
    (status) => {
      const visual = makeScene();
      const pending = sceneWithPendingNarration(visual);
      const next = { ...pending, ...narrationProgressPatch(status) };

      expect(next.content).toBe(visual.content);
      expect(next.actions).toEqual(visual.actions);
      expect(next.narrationStatus).toBe(status);
    },
  );

  it('keeps a generated slide and records a narration-only failure', () => {
    const visual = makeScene();
    const failed = { ...sceneWithPendingNarration(visual), ...narrationFailurePatch() };

    expect(failed.content).toBe(visual.content);
    expect(failed.actions).toEqual(visual.actions);
    expect(failed.narrationStatus).toBe('failed');
    expect(failed.narrationError).toContain('Narration is unavailable');
  });

  it('merges completed audio without mutating the committed scene working copy', () => {
    const current = sceneWithPendingNarration(makeScene());
    const generated = sceneForNarrationSynthesis(current);
    const generatedSpeech = generated.actions[0];
    if (generatedSpeech.type !== 'speech') throw new Error('Expected speech action');
    generatedSpeech.audioId = 'ast_narration';

    expect(current.actions[0]).not.toHaveProperty('audioId');
    expect(mergeCompletedNarration(current, generated)).toMatchObject({
      narrationStatus: 'completed',
      actions: [expect.objectContaining({ audioId: 'ast_narration' })],
    });
  });

  it('does not overwrite narration text edited while synthesis was running', () => {
    const generated = sceneForNarrationSynthesis(sceneWithPendingNarration(makeScene()));
    const generatedSpeech = generated.actions[0];
    if (generatedSpeech.type !== 'speech') throw new Error('Expected speech action');
    generatedSpeech.audioId = 'ast_stale';
    const edited = makeScene('Faculty-edited narration');

    const patch = mergeCompletedNarration(edited, generated);

    expect(patch.narrationStatus).toBe('needs-retry');
    expect(patch.actions?.[0]).toMatchObject({ text: 'Faculty-edited narration' });
    expect(patch.actions?.[0]).not.toHaveProperty('audioId');
  });
});
