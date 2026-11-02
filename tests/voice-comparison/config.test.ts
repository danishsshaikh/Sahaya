import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalVoiceProviderConfigured,
  externalVoiceProviderUnavailableReason,
  getSarvamTtsConfig,
} from '@/lib/server/voice-comparison-config';

afterEach(() => vi.unstubAllEnvs());

describe('Sarvam course narration configuration', () => {
  it('uses the dedicated server-only TTS flag and credential', () => {
    vi.stubEnv('SARVAM_TTS_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', 'server-secret');

    const config = getSarvamTtsConfig();
    expect(externalVoiceProviderConfigured(config)).toBe(true);
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', config)).toBeUndefined();
  });

  it('keeps the existing voice-cloning flag as a backwards-compatible fallback', () => {
    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', 'server-secret');

    expect(externalVoiceProviderConfigured(getSarvamTtsConfig())).toBe(true);
  });

  it('distinguishes a disabled feature from a missing server credential', () => {
    vi.stubEnv('SARVAM_TTS_ENABLED', 'false');
    vi.stubEnv('SARVAM_API_KEY', 'server-secret');
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', getSarvamTtsConfig())).toBe(
      'Sarvam AI is disabled on this deployment.',
    );

    vi.stubEnv('SARVAM_TTS_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', '');
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', getSarvamTtsConfig())).toBe(
      'Sarvam AI credentials are not configured on this server.',
    );
  });
});
