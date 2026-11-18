import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalVoiceProviderConfigured,
  externalVoiceProviderUnavailableReason,
  getSarvamVoiceCloningConfig,
} from '@/lib/server/voice-comparison-config';

afterEach(() => vi.unstubAllEnvs());

describe('Sarvam cloned narration configuration', () => {
  it('uses the server-only voice cloning flag and credential', () => {
    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', 'server-secret');

    const config = getSarvamVoiceCloningConfig();
    expect(externalVoiceProviderConfigured(config)).toBe(true);
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', config)).toBeUndefined();
  });

  it('distinguishes a disabled feature from a missing server credential', () => {
    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'false');
    vi.stubEnv('SARVAM_API_KEY', 'server-secret');
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', getSarvamVoiceCloningConfig())).toBe(
      'Sarvam AI is disabled on this deployment.',
    );

    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', '');
    expect(externalVoiceProviderUnavailableReason('Sarvam AI', getSarvamVoiceCloningConfig())).toBe(
      'Sarvam AI credentials are not configured on this server.',
    );
  });
});
