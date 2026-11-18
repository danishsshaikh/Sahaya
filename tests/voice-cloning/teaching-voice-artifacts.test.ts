import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupTeachingVoiceArtifacts,
  findTeachingVoiceArtifactByIdempotencyKey,
  persistTeachingVoiceArtifact,
  readTeachingVoiceArtifact,
  TeachingVoiceArtifactInvalidError,
} from '@/lib/voice-cloning/teaching-voice-artifacts';

function pcmWav(samples: number[]): Uint8Array {
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, output.byteLength - 8, true);
  output.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  output.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return output;
}

const jobId = 'rq_artifact_test_abcdefghijklmnop';
const idempotencyKey = 'a'.repeat(64);
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sahaya-teaching-voice-artifacts-'));
  vi.stubEnv('TEACHING_VOICE_JOB_ARTIFACT_DIR', directory);
  vi.stubEnv('TEACHING_VOICE_JOB_ARTIFACT_TTL_MS', String(60 * 60 * 1000));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Teaching Voice durable job artifacts', () => {
  it('atomically retains exact enhanced WAV bytes and resolves the idempotency index', async () => {
    const audio = pcmWav([1, 2, 3, 4]);
    const manifest = await persistTeachingVoiceArtifact({
      jobId,
      ownerId: 'faculty-a',
      idempotencyKey,
      audio,
      format: 'wav',
      metadata: { provider: 'qwen3-tts', stageId: 'stage-1', sceneId: 'scene-1' },
      now: 1_000,
    });

    expect(manifest).toMatchObject({
      jobId,
      byteLength: audio.byteLength,
      format: 'wav',
      metadata: { provider: 'qwen3-tts', stageId: 'stage-1' },
    });
    const retained = await readTeachingVoiceArtifact(jobId, 'faculty-a', 2_000);
    expect(retained?.audio).toEqual(audio);
    expect(
      (await findTeachingVoiceArtifactByIdempotencyKey('faculty-a', idempotencyKey, 2_000))?.audio,
    ).toEqual(audio);
  });

  it('does not reveal another owner’s completed audio', async () => {
    await persistTeachingVoiceArtifact({
      jobId,
      ownerId: 'faculty-a',
      idempotencyKey,
      audio: pcmWav([1, 2]),
      format: 'wav',
      metadata: { provider: 'qwen3-tts' },
      now: 1_000,
    });

    await expect(readTeachingVoiceArtifact(jobId, 'faculty-b', 2_000)).resolves.toBeNull();
    await expect(
      findTeachingVoiceArtifactByIdempotencyKey('faculty-b', idempotencyKey, 2_000),
    ).resolves.toBeNull();
  });

  it('retains fresh artifacts and cleans only artifacts beyond their retention window', async () => {
    const manifest = await persistTeachingVoiceArtifact({
      jobId,
      ownerId: 'faculty-a',
      idempotencyKey,
      audio: pcmWav([1, 2]),
      format: 'wav',
      metadata: { provider: 'qwen3-tts' },
      now: 1_000,
    });

    await cleanupTeachingVoiceArtifacts(manifest.expiresAt - 1);
    await expect(
      readTeachingVoiceArtifact(jobId, 'faculty-a', manifest.expiresAt - 1),
    ).resolves.not.toBeNull();

    await cleanupTeachingVoiceArtifacts(manifest.expiresAt + 1);
    await expect(
      readTeachingVoiceArtifact(jobId, 'faculty-a', manifest.expiresAt + 1),
    ).resolves.toBeNull();
  });

  it('rejects a corrupted retained artifact instead of serving or marking it valid', async () => {
    await persistTeachingVoiceArtifact({
      jobId,
      ownerId: 'faculty-a',
      idempotencyKey,
      audio: pcmWav([1, 2]),
      format: 'wav',
      metadata: { provider: 'qwen3-tts' },
      now: 1_000,
    });
    const owners = await fs.readdir(path.join(directory, 'owners'));
    const files = await fs.readdir(path.join(directory, 'owners', owners[0]!));
    const audioFile = files.find((file) => file.endsWith('.audio'))!;
    await fs.writeFile(path.join(directory, 'owners', owners[0]!, audioFile), new Uint8Array([1]));

    await expect(readTeachingVoiceArtifact(jobId, 'faculty-a', 2_000)).rejects.toBeInstanceOf(
      TeachingVoiceArtifactInvalidError,
    );
  });
});
