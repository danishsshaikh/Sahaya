import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionUser: vi.fn(),
  synthesizeFacultyVoice: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireSessionUser: mocks.requireSessionUser }));
vi.mock('@/lib/voice-cloning/synthesis', () => ({
  synthesizeFacultyVoice: mocks.synthesizeFacultyVoice,
}));

import { GET as getJob } from '@/app/api/generate/tts/jobs/[jobId]/route';
import { GET as getAudio } from '@/app/api/generate/tts/jobs/[jobId]/audio/route';
import {
  enqueueTeachingVoiceJob,
  enqueueTeachingVoiceJobDurably,
  readTeachingVoiceJob,
} from '@/lib/voice-cloning/teaching-voice-jobs';
import { clearResourceJobQueueForTests } from '@/lib/server/resource-job-queue';

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

async function waitForCompletion(jobId: string, ownerId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readTeachingVoiceJob(jobId, ownerId)?.status === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Teaching Voice job ${jobId} did not complete`);
}

let directory: string;

beforeEach(async () => {
  clearResourceJobQueueForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sahaya-teaching-voice-route-'));
  vi.stubEnv('TEACHING_VOICE_JOB_ARTIFACT_DIR', directory);
  vi.stubEnv('TEACHING_VOICE_JOB_ARTIFACT_TTL_MS', String(60 * 60 * 1000));
  mocks.requireSessionUser.mockResolvedValue({ id: 'faculty-a' });
  mocks.synthesizeFacultyVoice.mockReset();
});

afterEach(async () => {
  clearResourceJobQueueForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('Teaching Voice completed-job audio lifecycle', () => {
  it('serves validated enhanced WAV bytes after the process-local queue is lost', async () => {
    const enhancedAudio = pcmWav([100, 200, 300, 400]);
    mocks.synthesizeFacultyVoice.mockResolvedValue({ audio: enhancedAudio, format: 'wav' });
    const input = {
      providerId: 'qwen3-tts',
      ownerId: 'faculty-a',
      profileId: 'vcp_owned',
      text: 'Existing narration text.',
      language: 'en-IN',
      audioId: 'tts_scene-1_action-1',
      stageId: 'stage-browser-backed',
      sceneId: 'scene-1',
    } as const;
    const { job } = enqueueTeachingVoiceJob(input);
    await waitForCompletion(job.id, 'faculty-a');

    // Simulate a Next.js development reload or a route handled by a process
    // that does not share the producer's globalThis queue.
    clearResourceJobQueueForTests();

    const statusResponse = await getJob(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${job.id}`),
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      jobId: job.id,
      status: 'completed',
      audioUrl: `/api/generate/tts/jobs/${job.id}/audio`,
    });

    const audioResponse = await getAudio(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${job.id}/audio`),
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(audioResponse.status).toBe(200);
    expect(audioResponse.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await audioResponse.arrayBuffer())).toEqual(enhancedAudio);

    const retained = await enqueueTeachingVoiceJobDurably(input);
    expect(retained).toMatchObject({ reused: true, job: { id: job.id, status: 'completed' } });
    expect(mocks.synthesizeFacultyVoice).toHaveBeenCalledOnce();
  });

  it('returns a non-disclosing 404 instead of another owner’s audio', async () => {
    const enhancedAudio = pcmWav([100, 200]);
    mocks.synthesizeFacultyVoice.mockResolvedValue({ audio: enhancedAudio, format: 'wav' });
    const { job } = enqueueTeachingVoiceJob({
      providerId: 'qwen3-tts',
      ownerId: 'faculty-a',
      profileId: 'vcp_owned',
      text: 'Private narration.',
      language: 'en-IN',
      audioId: 'tts_scene-1_action-1',
    });
    await waitForCompletion(job.id, 'faculty-a');
    clearResourceJobQueueForTests();
    mocks.requireSessionUser.mockResolvedValue({ id: 'faculty-b' });

    const response = await getAudio(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${job.id}/audio`),
      { params: Promise.resolve({ jobId: job.id }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: 'TTS_JOB_NOT_FOUND',
    });
  });

  it('distinguishes a missing artifact from synthesis and enhancement failures', async () => {
    const missing = await getAudio(
      new NextRequest('http://localhost/api/generate/tts/jobs/rq_missing_abcdefghijklmnop/audio'),
      { params: Promise.resolve({ jobId: 'rq_missing_abcdefghijklmnop' }) },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      errorCode: 'TTS_JOB_NOT_FOUND',
    });

    mocks.synthesizeFacultyVoice.mockRejectedValue(
      new Error('Resemble enhancement failed after synthesis'),
    );
    const { job: failed } = enqueueTeachingVoiceJob({
      providerId: 'qwen3-tts',
      ownerId: 'faculty-a',
      profileId: 'vcp_owned',
      text: 'Narration.',
      language: 'en-IN',
      audioId: 'tts_failed',
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (readTeachingVoiceJob(failed.id, 'faculty-a')?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const response = await getJob(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${failed.id}`),
      { params: Promise.resolve({ jobId: failed.id }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'TTS_ENHANCEMENT_FAILED',
    });
  });

  it('reports a missing completed artifact and permits a clean single-action retry', async () => {
    const enhancedAudio = pcmWav([100, 200]);
    mocks.synthesizeFacultyVoice.mockResolvedValue({ audio: enhancedAudio, format: 'wav' });
    const input = {
      providerId: 'qwen3-tts' as const,
      ownerId: 'faculty-a',
      profileId: 'vcp_owned',
      text: 'Retry only this narration.',
      language: 'en-IN',
      audioId: 'tts_scene-1_action-retry',
      stageId: 'stage-browser-backed',
      sceneId: 'scene-1',
    };
    const { job: original } = enqueueTeachingVoiceJob(input);
    await waitForCompletion(original.id, 'faculty-a');
    clearResourceJobQueueForTests();

    const owners = await fs.readdir(path.join(directory, 'owners'));
    const ownerDirectory = path.join(directory, 'owners', owners[0]!);
    const files = await fs.readdir(ownerDirectory);
    const originalAudio = files.find((file) => file === `${original.id}.audio`)!;
    await fs.unlink(path.join(ownerDirectory, originalAudio));

    const missing = await getAudio(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${original.id}/audio`),
      { params: Promise.resolve({ jobId: original.id }) },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      errorCode: 'TTS_AUDIO_ARTIFACT_MISSING',
    });

    const retry = await enqueueTeachingVoiceJobDurably(input);
    expect(retry.job.id).not.toBe(original.id);
    await waitForCompletion(retry.job.id, 'faculty-a');
    const recovered = await getAudio(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${retry.job.id}/audio`),
      { params: Promise.resolve({ jobId: retry.job.id }) },
    );
    expect(recovered.status).toBe(200);
    expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(enhancedAudio);
    expect(mocks.synthesizeFacultyVoice).toHaveBeenCalledTimes(2);
  });
});
