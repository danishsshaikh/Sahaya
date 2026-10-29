import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'components/voice-cloning/teaching-voice-card.tsx'),
  'utf8',
);

describe('simplified Teaching Voice faculty UI', () => {
  it('shows one record or upload workflow without technical configuration', () => {
    expect(source).toContain('My Teaching Voice');
    expect(source).toContain('Record Voice');
    expect(source).toContain('Upload Audio');
    expect(source).toContain('Generate Voice');
    expect(source).toContain('Voice ready');
    expect(source).not.toContain('Customize Voice');
    expect(source).not.toContain('Generate Preview');
    expect(source).not.toContain('VoiceComparisonPanel');
    expect(source).not.toContain('Voice Output');
    expect(source).not.toContain('Use These Settings');
  });

  it('uses one explicit enhanced enrollment action and blocks duplicate requests', () => {
    expect(source).toContain("formData.set('workflow', 'enhanced-qwen')");
    expect(source).toContain('requestInFlightRef.current');
    expect(source).toContain('applyCompletedProfile(data.profile)');
    expect(source).toContain("action: 'activate-enhanced-qwen'");
    expect(source).not.toContain("action: 'preview-model'");
    expect(source).not.toContain("action: 'accept-preview'");
  });

  it('keeps upload transcription explicit and editable', () => {
    expect(source).toContain('Transcribe Audio');
    expect(source).toContain("fetch('/api/transcription'");
    expect(source).toContain('Enter or correct the exact words spoken');
    expect(source).toContain("formData.set('referenceText', transcript.trim())");
    expect(source).toContain('I own this recording or have explicit permission');
    expect(source).toContain('previous voices are preserved');
  });
});
