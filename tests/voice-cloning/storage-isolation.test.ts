import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

  it('retains exact original enrollment bytes in owner-scoped protected storage', async () => {
    const { writeOriginalRecording } = await import('@/lib/voice-cloning/storage');
    const bytes = new Uint8Array([9, 1, 4, 1, 5, 9, 2, 6]);
    const stored = await writeOriginalRecording('vcp_a', 'usr_a', {
      bytes,
      mimeType: 'audio/ogg;codecs=opus',
      fileName: 'faculty.ogg',
    });
    expect(stored.key).toContain(join('users', 'usr_a', 'voice-profiles', 'vcp_a'));
    expect(stored.mimeType).toBe('audio/ogg;codecs=opus');
    expect(stored.byteLength).toBe(bytes.byteLength);
    expect(
      createHash('sha256')
        .update(await readFile(stored.key))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('looks up and replaces only ready profiles in the requested language', async () => {
    const { findCurrentVoiceProfile, writeVoiceProfile } =
      await import('@/lib/voice-cloning/storage');
    await writeVoiceProfile(profile('usr_a', 'vcp_en'));
    await writeVoiceProfile({ ...profile('usr_a', 'vcp_hi'), language: 'hi' });
    await writeVoiceProfile({ ...profile('usr_a', 'vcp_mr'), language: 'mr' });
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_candidate'),
      language: 'hi',
      status: 'failed',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
    await expect(findCurrentVoiceProfile('usr_a', 'en', true)).resolves.toMatchObject({
      id: 'vcp_en',
    });
    await expect(findCurrentVoiceProfile('usr_a', 'hi', true)).resolves.toMatchObject({
      id: 'vcp_hi',
    });
    await expect(findCurrentVoiceProfile('usr_a', 'mr', true)).resolves.toMatchObject({
      id: 'vcp_mr',
    });
    await expect(findCurrentVoiceProfile('usr_a')).resolves.toMatchObject({ id: 'vcp_candidate' });
    await expect(findCurrentVoiceProfile('usr_b', 'hi', true)).resolves.toBeNull();
  });

  it('keeps lookup keyed to the reference language when Chatterbox synthesis changes', async () => {
    const { findCurrentVoiceProfile, writeVoiceProfile } =
      await import('@/lib/voice-cloning/storage');
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_cross_language'),
      language: 'en',
      languageId: 'hi',
    });

    await expect(findCurrentVoiceProfile('usr_a', 'en', true)).resolves.toMatchObject({
      id: 'vcp_cross_language',
      language: 'en',
      languageId: 'hi',
    });
    await expect(findCurrentVoiceProfile('usr_a', 'hi', true)).resolves.toBeNull();
  });

  it('lists every ready owner profile by creation time rather than modification time', async () => {
    const { listVoiceProfiles, writeVoiceProfile } = await import('@/lib/voice-cloning/storage');
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_previous'),
      displayName: 'Previous voice',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
    });
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_newest'),
      displayName: 'Newest voice',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    await writeVoiceProfile({
      ...profile('usr_a', 'vcp_failed'),
      status: 'failed',
      createdAt: '2026-08-30T00:00:00.000Z',
    });
    await writeVoiceProfile(profile('usr_b', 'vcp_other_owner'));

    await expect(listVoiceProfiles('usr_a', { readyOnly: true })).resolves.toMatchObject([
      { id: 'vcp_newest' },
      { id: 'vcp_previous' },
    ]);
  });
});
