import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'components/voice-cloning/teaching-voice-card.tsx'),
  'utf8',
);

describe('Teaching Voice faculty UI', () => {
  it('keeps the ordinary Chatterbox controls limited to style, accent, and output', () => {
    const controls = source.slice(
      source.indexOf('const renderVoiceConfigurationControls'),
      source.indexOf('const startRecording'),
    );

    expect(controls).toContain('Voice Style');
    expect(controls).toContain('Accent');
    expect(controls).toContain('Hindi-influenced');
    expect(controls).toContain('Voice Output');
    expect(controls).not.toContain('Voice Model');
    expect(controls).not.toContain('Advanced Voice Settings');
    expect(controls).not.toContain('Expert Settings');
    expect(controls).not.toContain('Accent Test');
  });

  it('keeps preview text in English when accent conditioning changes', () => {
    expect(source).toContain("setPreviewTextLanguageId('en')");
    expect(source).toContain('Your lesson text is not translated.');
  });

  it('resets a completed take before another explicit recording start', () => {
    expect(source).toContain('const prepareForRerecord = () =>');
    expect(source).toContain('onClick={prepareForRerecord}');
    expect(source.match(/onClick=\{startRecording\}/g)).toHaveLength(1);
  });

  it('activates an accepted ready profile and preserves an intentional disable', () => {
    expect(source).toContain('activateProfile(data.profile)');
    expect(source).toContain(
      'disableTeachingVoiceSelection(profileSelectionLanguage(next), next.id)',
    );
    expect(source).toContain('isTeachingVoiceExplicitlyDisabled(persisted, next.id)');
  });
});
