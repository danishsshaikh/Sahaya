import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const classroomSources = [
  'app/classroom/[id]/page.tsx',
  'components/classroom/ClassroomSurface.tsx',
] as const;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('classroom generation progress render contract', () => {
  it.each(classroomSources)(
    '%s keeps Stage mounted and passes progress into the classroom toolbar',
    (path) => {
      const text = source(path);

      expect(text).toContain('<Stage');
      expect(text).toContain('ClassroomLessonGenerationProgress');
      expect(text).toContain("event: 'classroom-render-enabled'");
      expect(text).toContain("event: 'progress-overlay-hidden'");
      expect(text).toContain("event: 'classroom-still-mounted-after-completion'");
      expect(text).toContain('onNarrationQueueChange: updateTeachingVoiceQueue');
      expect(text).toContain('progress={generationProgress}');
      expect(text).toContain('generationStatus={');
      expect(text).not.toContain('pointer-events-none absolute right-4 top-4');

      const stageIndex = text.indexOf('<Stage');
      const progressIndex = text.indexOf('<ClassroomLessonGenerationProgress');
      expect(stageIndex).toBeGreaterThan(0);
      expect(progressIndex).toBeGreaterThan(stageIndex);
    },
  );

  it('uses shared attempt statuses and forwards the narration queue progress', () => {
    const text = source('components/generation/lesson-generation-progress.tsx');
    expect(text).toContain('sceneAttemptLabel(outline.type, attempt)');
    expect(text).toContain('<LessonGenerationProgress {...progress} />');
    expect(text).toContain('teachingVoiceQueuePositionLabel(teachingVoiceQueue)');
  });

  it.each(classroomSources)(
    '%s does not make all-scene completion a classroom render gate',
    (path) => {
      const text = source(path);
      const renderBranch = text.slice(
        text.indexOf('return ('),
        text.lastIndexOf('</ThemeProvider>'),
      );

      expect(renderBranch).toContain('<Stage');
      expect(renderBranch).not.toMatch(/generationComplete\s*\?/);
      expect(renderBranch).not.toMatch(/generationProgress\s*\?\s*<Stage/);
      expect(renderBranch).not.toContain('sceneCount === totalScenes');
    },
  );
});
