import { describe, expect, it } from 'vitest';
import { buildBrowserCourseNarrationRegistration } from '@/lib/course-narration/browser-registration';
import type { Scene, Stage } from '@/lib/types/stage';

describe('StageStorage browser course narration projection', () => {
  it('preserves the real stage and scenes while selecting exact narration fields only', () => {
    const stage = {
      id: 'browser-stage',
      name: 'Existing browser course',
      createdAt: 1,
      updatedAt: 2,
      teacherVoiceProfileId: 'profile-1',
      lessonLanguage: 'en',
      style: 'professional',
    } as Stage;
    const scenes = [
      {
        id: 'scene-1',
        stageId: 'browser-stage',
        title: 'Existing slide',
        order: 1,
        type: 'slide',
        content: {
          type: 'slide',
          canvas: { width: 1280, height: 720, backgroundColor: '#fff' },
          elements: [{ id: 'visual-1', type: 'text', text: 'Do not upload or change me' }],
        },
        actions: [
          {
            id: 'speech-1',
            type: 'speech',
            text: '  Exact existing transcript.  ',
            audioId: 'original-audio',
          },
        ],
      } as unknown as Scene,
    ];
    const before = structuredClone({ stage, scenes });

    const payload = buildBrowserCourseNarrationRegistration(stage, scenes);

    expect(payload.scenes).toEqual([
      {
        id: 'scene-1',
        speech: [
          {
            id: 'speech-1',
            text: '  Exact existing transcript.  ',
            audioId: 'original-audio',
          },
        ],
      },
    ]);
    expect(payload.scenes[0]).not.toHaveProperty('content');
    expect({ stage, scenes }).toEqual(before);
  });
});
