import { describe, expect, it } from 'vitest';
import {
  BODHAN_VOICES,
  SARVAM_LANGUAGE_CODES,
  SARVAM_TTS_LANGUAGE_CODES,
  SARVAM_VOICES,
  VOICE_COMPARISON_PROVIDERS,
} from '@/lib/voice-comparison/catalog';

describe('voice comparison provider catalog', () => {
  it('keeps the documented Bodhan preset catalog and provider distinction', () => {
    expect(BODHAN_VOICES).toHaveLength(45);
    expect(BODHAN_VOICES).toContainEqual({
      id: 'Anagha',
      name: 'Anagha',
      recordedLanguage: 'mr',
      recordedLanguageLabel: 'Marathi',
    });
    expect(VOICE_COMPARISON_PROVIDERS.find(({ id }) => id === 'bodhan')).toMatchObject({
      voiceType: 'preset',
      supportsCloning: false,
      supportsClassroom: false,
    });
  });

  it('maps only documented Sarvam target languages', () => {
    expect(Object.keys(SARVAM_LANGUAGE_CODES)).toHaveLength(12);
    expect(SARVAM_LANGUAGE_CODES.or).toBe('od-IN');
    expect(SARVAM_LANGUAGE_CODES.mr).toBe('mr-IN');
    expect(SARVAM_LANGUAGE_CODES.ur).toBeUndefined();
  });

  it('keeps Bulbul preset coverage separate from voice-cloning coverage', () => {
    expect(Object.keys(SARVAM_TTS_LANGUAGE_CODES)).toHaveLength(11);
    expect(SARVAM_TTS_LANGUAGE_CODES.en).toBe('en-IN');
    expect(SARVAM_TTS_LANGUAGE_CODES.as).toBeUndefined();
    expect(SARVAM_VOICES).toContainEqual({ id: 'shubh', name: 'Shubh' });
    expect(VOICE_COMPARISON_PROVIDERS.find(({ id }) => id === 'sarvam')).toMatchObject({
      supportsCloning: true,
      supportsPresetVoices: true,
    });
  });
});
