import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LessonGenerationProgress } from '@/components/generation/lesson-generation-progress';

describe('Teaching Voice queue progress UI', () => {
  it('keeps the collapsed toolbar indicator compact and removes overall percentage', () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'content',
      }),
    );
    expect(html).toContain('Generating');
    expect(html).toContain('Slide 2/5');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('%');
    expect(html).not.toContain('Lesson generation details');
  });

  it('shows queue position but omits wait text when the server supplies no ETA', () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'narration',
        defaultExpanded: true,
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
    expect(html).not.toContain('Estimating wait...');
    expect(html).not.toContain('>96%<');
  });

  it("shows You're next and a coarse ETA only when supplied by the server", () => {
    const html = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 2,
        totalScenes: 5,
        phase: 'narration',
        defaultExpanded: true,
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

  it('shows running narration and finalizing states independently from slide progress', () => {
    const running = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 4,
        totalScenes: 4,
        phase: 'narration',
        defaultExpanded: true,
        teachingVoiceQueue: {
          status: 'running',
          queuePosition: null,
          jobsAhead: null,
          estimatedWaitMs: null,
        },
      }),
    );
    const finalizing = renderToStaticMarkup(
      createElement(LessonGenerationProgress, {
        sceneIndex: 4,
        totalScenes: 4,
        phase: 'finalizing',
        defaultExpanded: true,
      }),
    );

    expect(running).toContain('Creating voice narration');
    expect(running).toContain('Current slide content ready');
    expect(finalizing).toContain('Narration ready');
  });
});
