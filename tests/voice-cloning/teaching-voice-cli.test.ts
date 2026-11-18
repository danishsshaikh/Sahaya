import { describe, expect, it, vi } from 'vitest';
import { runTeachingVoiceProfileCli } from '@/scripts/teaching-voice-profile';
import type { PublicAuthUser } from '@/lib/auth/server';
import type { VoiceProfile } from '@/lib/voice-cloning/types';

const owner: PublicAuthUser = {
  id: 'faculty_owner',
  name: 'Faculty Owner',
  email: 'faculty@mituniversity.edu.in',
  role: 'faculty',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  classroomsCreatedCount: 1,
  voiceConfigured: true,
};

function profile(id = 'vcp_RYn-oAtrY3ptceg6'): VoiceProfile {
  return {
    id,
    ownerId: owner.id,
    displayName: 'Previous English voice',
    provider: 'chatterbox',
    language: 'en',
    status: 'ready',
    createdAt: '2026-10-26T10:00:00.000Z',
    updatedAt: '2026-10-26T10:00:00.000Z',
    consentTimestamp: '2026-10-26T10:00:00.000Z',
    consentVersion: 'faculty-self-voice-v1',
    referenceAudioKey: '/authorized/reference.wav',
    referenceText: 'Exact transcript.',
    providerReferenceId: 'provider-reference',
    profileVersion: 1,
  };
}

function output() {
  return { log: vi.fn(), error: vi.fn() };
}

describe('Teaching Voice terminal utility', () => {
  it('lists only profiles returned for the resolved active owner with creation and compatibility', async () => {
    const io = output();
    const dependencies = {
      listUsers: vi.fn(async () => [owner]),
      listProfiles: vi.fn(async () => [profile()]),
      activate: vi.fn(),
    };

    await expect(
      runTeachingVoiceProfileCli(['list', '--user', owner.email], io, dependencies),
    ).resolves.toBe(0);
    expect(dependencies.listProfiles).toHaveBeenCalledWith(owner.id);
    expect(io.log.mock.calls.flat().join('\n')).toContain('vcp_RYn-oAtrY3ptceg6');
    expect(io.log.mock.calls.flat().join('\n')).toContain('created=2026-10-26');
    expect(io.log.mock.calls.flat().join('\n')).toContain('updated=2026-10-26');
    expect(io.log.mock.calls.flat().join('\n')).toContain('providers=chatterbox, qwen3-tts');
  });

  it('activates exactly the requested owner-ready profile without touching a course binding', async () => {
    const io = output();
    const selected = profile();
    const dependencies = {
      listUsers: vi.fn(async () => [owner]),
      listProfiles: vi.fn(async () => [selected]),
      activate: vi.fn(async () => selected),
    };

    await expect(
      runTeachingVoiceProfileCli(
        ['activate', '--user', owner.id, '--profile', selected.id],
        io,
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(dependencies.activate).toHaveBeenCalledWith(owner.id, selected.id);
    expect(io.log).toHaveBeenCalledWith(
      expect.stringContaining('course bindings were not changed'),
    );
  });

  it('rejects unknown or disabled users before accessing voice storage', async () => {
    const io = output();
    const dependencies = {
      listUsers: vi.fn(async () => [{ ...owner, status: 'disabled' as const }]),
      listProfiles: vi.fn(),
      activate: vi.fn(),
    };

    await expect(
      runTeachingVoiceProfileCli(
        ['activate', '--user', owner.id, '--profile', profile().id],
        io,
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(dependencies.activate).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith('The requested Sahaya user is not active.');
  });
});
