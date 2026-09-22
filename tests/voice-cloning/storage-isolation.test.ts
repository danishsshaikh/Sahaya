import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';

let storageDir: string;

function profile(ownerId: string, id: string): VoiceProfile {
  return {
    id,
    ownerId,
    displayName: 'Teaching Voice',
    provider: 'chatterbox',
    language: 'en',
    status: 'ready',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    consentTimestamp: '2026-08-14T00:00:00.000Z',
    consentVersion: 'faculty-self-voice-v1',
    providerReferenceId: 'provider-ref',
    profileVersion: 1,
  };
}

describe('voice profile user isolation', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    storageDir = await mkdtemp(join(tmpdir(), 'openmaic-voice-'));
    vi.stubEnv('VOICE_CLONING_STORAGE_DIR', storageDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('keeps user A and user B profiles in separate owner-scoped directories', async () => {
    const {
      findCurrentVoiceProfile,
      readVoiceProfile,
      referenceAudioExists,
      writeReferenceAudio,
      writeVoiceProfile,
    } = await import('@/lib/voice-cloning/storage');

    await writeVoiceProfile(profile('usr_a', 'vcp_a'));
    await writeVoiceProfile(profile('usr_b', 'vcp_b'));
    const referenceKey = await writeReferenceAudio('vcp_a', 'usr_a', new Uint8Array([1, 2, 3]));

    await expect(readVoiceProfile('vcp_a', 'usr_a')).resolves.toMatchObject({ ownerId: 'usr_a' });
    await expect(readVoiceProfile('vcp_a', 'usr_b')).resolves.toBeNull();
    await expect(findCurrentVoiceProfile('usr_b')).resolves.toMatchObject({ id: 'vcp_b' });
    await expect(referenceAudioExists(referenceKey)).resolves.toBe(true);
    expect(referenceKey).toContain(join('users', 'usr_a', 'voice-profiles', 'vcp_a'));
  });

  it('looks up and replaces only ready profiles in the requested language', async () => {
    const { findCurrentVoiceProfile, writeVoiceProfile } = await import('@/lib/voice-cloning/storage');
    await writeVoiceProfile(profile('usr_a', 'vcp_en'));
    await writeVoiceProfile({ ...profile('usr_a', 'vcp_hi'), language: 'hi' });
    await writeVoiceProfile({ ...profile('usr_a', 'vcp_mr'), language: 'mr' });
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_candidate'), language: 'hi', status: 'failed',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
    await expect(findCurrentVoiceProfile('usr_a', 'en', true)).resolves.toMatchObject({ id: 'vcp_en' });
    await expect(findCurrentVoiceProfile('usr_a', 'hi', true)).resolves.toMatchObject({ id: 'vcp_hi' });
    await expect(findCurrentVoiceProfile('usr_a', 'mr', true)).resolves.toMatchObject({ id: 'vcp_mr' });
    await expect(findCurrentVoiceProfile('usr_a')).resolves.toMatchObject({ id: 'vcp_candidate' });
    await expect(findCurrentVoiceProfile('usr_b', 'hi', true)).resolves.toBeNull();
  });
});
