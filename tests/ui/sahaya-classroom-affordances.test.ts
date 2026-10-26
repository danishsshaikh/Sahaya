import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const previewPage = readFileSync(join(root, 'app/generation-preview/page.tsx'), 'utf8');
const visualizers = readFileSync(
  join(root, 'app/generation-preview/components/visualizers.tsx'),
  'utf8',
);
const toolbar = readFileSync(join(root, 'components/canvas/canvas-toolbar.tsx'), 'utf8');
const homePage = readFileSync(join(root, 'app/page.tsx'), 'utf8');
const english = JSON.parse(readFileSync(join(root, 'lib/i18n/locales/en-US.json'), 'utf8')) as {
  toolbar: { enterClassroom: string };
  generation: { outlineExpandHint: string };
};

describe('Sahaya classroom action affordances', () => {
  it('uses a native secondary button for course-outline review', () => {
    expect(english.generation.outlineExpandHint).toBe('Review Course Outline');
    expect(previewPage).toContain('<ListTree className="size-4" />');
    expect(previewPage).toContain('variant="outline"');
    expect(previewPage).toContain('onClick={handleExpandStreamingOutline}');
    expect(visualizers).not.toContain('role={isInteractive');
    expect(visualizers).not.toContain('onKeyDown={handleKeyDown}');
  });

  it('keeps Enter Classroom as the primary generation action', () => {
    expect(english.toolbar.enterClassroom).toBe('Enter Classroom');
    expect(homePage).toContain("t('toolbar.enterClassroom')");
  });

  it('identifies the whiteboard without edit iconography on desktop and mobile', () => {
    expect(toolbar).toContain('Presentation,');
    expect(toolbar).not.toContain('PencilLine');
    expect(toolbar).toContain("aria-label={whiteboardOpen ? t('whiteboard.minimize')");
    expect(toolbar).toContain('aria-pressed={whiteboardOpen}');
    expect(toolbar).toContain("'h-6 w-6 gap-1 px-0 xl:w-auto xl:px-1.5'");
    expect(toolbar).toContain("t('whiteboard.open')");
    expect(toolbar).toContain('<TooltipContent side="top"');
  });
});
