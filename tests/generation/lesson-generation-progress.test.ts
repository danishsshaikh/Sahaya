import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LessonGenerationProgress } from '@/components/generation/lesson-generation-progress';

describe('Teaching Voice queue progress UI', () => {
  it('shows compact server queue position without a fake ETA', () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'narration',
        teachingVoiceQueue: {
          status: 'queued',
          queuePosition: 3,
          jobsAhead: 2,
          estimatedWaitMs: null,
        },
      }),
    );
    expect(html).toContain('Teaching Voice queued');
    expect(html).toContain('2 requests ahead');
    expect(html).toContain('Estimating wait...');
    expect(html).not.toMatch(/\d+:\d+/);
  });

  it("shows You're next and a coarse ETA supplied by the server", () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'narration',
        teachingVoiceQueue: {
          status: 'queued',
          queuePosition: 1,
          jobsAhead: 0,
          estimatedWaitMs: 120_000,
        },
      }),
    );
    expect(html).toContain('You&#x27;re next');
    expect(html).toContain('About 2 min wait');
  });

  it('returns to active narration copy when the job starts running', () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'narration',
        teachingVoiceQueue: {
          status: 'running',
          queuePosition: null,
          jobsAhead: null,
          estimatedWaitMs: null,
        },
      }),
    );
    expect(html).toContain('Creating voice narration...');
    expect(html).not.toContain('Teaching Voice queued');
  });
});
