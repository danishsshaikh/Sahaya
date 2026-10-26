import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Sahaya default-off feature surfaces', () => {
  it('gates homepage-only controls while retaining Teaching Voice and recent classrooms', () => {
    const page = source('app/page.tsx');

    expect(page).toContain('staticVoiceEnabled ? (');
    expect(page).toContain('<AgentBar />');
    expect(page).toContain('promptPersonalizationEnabled ? <GreetingBar />');
    expect(page).toContain('classroomImportEnabled ? (');
    expect(page).toContain('<TeachingVoiceCard');
    expect(page).toContain('recentClassroomsOpen');
    expect(page).not.toContain('{brandConfig.heroEyebrow}');
    expect(page).not.toContain('{brandConfig.productDescription}');
    expect(page).toContain('{HOMEPAGE_TAGLINE}');
  });

  it('does not hydrate or submit Web Search while its feature flag is off', () => {
    const page = source('app/page.tsx');
    const toolbar = source('components/generation/generation-toolbar.tsx');

    expect(page).toContain(
      'webSearchEnabled ? localStorage.getItem(WEB_SEARCH_STORAGE_KEY) : null',
    );
    expect(page).toContain('webSearch: webSearchEnabled && form.webSearch ? true : undefined');
    expect(toolbar).toContain('webSearchFeatureEnabled ? (');

    const controlStart = toolbar.indexOf('function WebSearchControl');
    expect(controlStart).toBeGreaterThan(0);
    expect(toolbar.indexOf('s.webSearchProviderId')).toBeGreaterThan(controlStart);
    expect(toolbar.indexOf('s.webSearchProvidersConfig')).toBeGreaterThan(controlStart);
  });

  it('does not mount static voice or personalization initializers unless enabled', () => {
    const page = source('app/page.tsx');
    const staticVoiceGate = page.indexOf('staticVoiceEnabled ? (');
    const agentBar = page.indexOf('<AgentBar />', staticVoiceGate);
    const personalizationGate = page.indexOf('promptPersonalizationEnabled ? <GreetingBar />');

    expect(staticVoiceGate).toBeGreaterThan(0);
    expect(agentBar).toBeGreaterThan(staticVoiceGate);
    expect(personalizationGate).toBeGreaterThan(0);
  });

  it('keeps generic narration generation and classroom controls behind static voice', () => {
    const generator = source('lib/hooks/use-scene-generator.ts');
    const discussion = source('lib/hooks/use-discussion-tts.ts');
    const actions = source('components/edit/ActionsBar/ActionsBar.tsx');

    expect(generator).toContain('!teacherVoiceProfileId && !isStaticVoiceEnabled()');
    expect(discussion).toContain('const playbackEnabled = enabled && isStaticVoiceEnabled()');
    expect(actions).toContain('isStaticVoiceEnabled() &&');
  });

  it('gates the Whiteboard launcher, data subscription, and mounted surface', () => {
    const area = source('components/canvas/canvas-area.tsx');
    const toolbar = source('components/canvas/canvas-toolbar.tsx');

    expect(area).toContain('const whiteboardEnabled = isWhiteboardEnabled()');
    expect(area).toContain('whiteboardEnabled ? (');
    expect(area).toContain('<Whiteboard isOpen={visibleWhiteboardOpen}');
    expect(toolbar).toContain('whiteboardEnabled ? (');

    const controlStart = toolbar.indexOf('function WhiteboardControl');
    expect(toolbar.indexOf('state.stage?.whiteboard')).toBeGreaterThan(controlStart);
  });

  it('keeps the compact generation trigger constrained at narrow widths', () => {
    const progress = source('components/generation/lesson-generation-progress.tsx');

    expect(progress).toContain('max-w-[11.5rem]');
    expect(progress).toContain('w-[min(20rem,calc(100vw-2rem))]');
    expect(progress).toContain('hidden font-medium sm:inline');
  });

  it('renders compact prompt chips that populate the editor without submitting', () => {
    const page = source('app/page.tsx');
    const suggestion = source('components/ai-elements/suggestion.tsx');

    expect(page).toContain('placeholder="What would you like to teach today?"');
    expect(page).toContain('<Suggestions');
    expect(page).toContain('Explain a Concept');
    expect(page).toContain('Tell a Historical Story');
    expect(page).toContain('Create a Quiz');
    expect(page).toContain('Teach with Examples');
    expect(page).toContain("updateForm('requirement', value)");
    expect(suggestion).toContain('rounded-full');
    expect(suggestion).toContain('type="button"');
  });
});
