import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireSessionUser: vi.fn(),
  resolveProvider: vi.fn(),
  synthesize: vi.fn(),
  enqueue: vi.fn(),
  read: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
  generateTTS: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireSessionUser: mocks.requireSessionUser }));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: vi.fn() }));
vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});
vi.mock('@/lib/voice-cloning/synthesis', () => ({
  resolveFacultyVoiceProviderId: mocks.resolveProvider,
  synthesizeFacultyVoice: mocks.synthesize,
}));
vi.mock('@/lib/voice-cloning/teaching-voice-jobs', () => ({
  enqueueQwenTeachingVoiceJob: mocks.enqueue,
  readTeachingVoiceJob: mocks.read,
  readTeachingVoiceJobResult: mocks.result,
  cancelTeachingVoiceJob: mocks.cancel,
  isValidTeachingVoiceJobId: () => true,
}));

import { POST } from '@/app/api/generate/tts/route';
import { GET as getJob } from '@/app/api/generate/tts/jobs/[jobId]/route';
import { GET as getAudio } from '@/app/api/generate/tts/jobs/[jobId]/audio/route';

const jobId = 'rq_abcdefghijklmnopqrstuvwxyz';
const user = { id: 'faculty-a' };

function postRequest() {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Narration',
      audioId: 'tts_s1_action-1',
      teacherVoiceProfileId: 'vcp_faculty',
      ttsLanguageCode: 'en',
      stageId: 'stage-1',
      sceneId: 'scene-1',
    }),
  });
}

function snapshot(status: 'queued' | 'running' | 'completed' = 'queued') {
  return {
    id: jobId,
    resourceKey: 'teaching-voice:qwen3',
    status,
    enqueuedAt: 1,
    queuePosition: status === 'queued' ? 2 : null,
    jobsAhead: status === 'queued' ? 1 : null,
    queueDepth: 2,
    estimatedWaitMs: status === 'queued' ? 90_000 : null,
    attemptCount: status === 'running' ? 1 : 0,
    metadata: { provider: 'qwen3' },
  };
}

describe('Teaching Voice async TTS routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSessionUser.mockResolvedValue(user);
    mocks.resolveProvider.mockResolvedValue('qwen3');
    mocks.enqueue.mockReturnValue({ job: snapshot(), reused: false });
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([4, 5]), format: 'mp3' });
  });

  it('returns Qwen queue admission immediately as HTTP 202', async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      async: true,
      jobId,
      status: 'queued',
      queuePosition: 2,
      jobsAhead: 1,
      estimatedWaitMs: 90_000,
      statusUrl: `/api/generate/tts/jobs/${jobId}`,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'faculty-a', stageId: 'stage-1', sceneId: 'scene-1' }),
    );
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('returns a retained completed job without creating synchronous audio JSON', async () => {
    mocks.enqueue.mockReturnValue({ job: snapshot('completed'), reused: true });
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'completed',
      audioUrl: `/api/generate/tts/jobs/${jobId}/audio`,
    });
  });

  it('preserves synchronous behavior for non-Qwen Teaching Voice', async () => {
    mocks.resolveProvider.mockResolvedValue('indicf5');
    mocks.synthesize.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'wav' });
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, format: 'wav' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('does not send Standard Voice through the Qwen resource queue', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/generate/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Standard narration',
          audioId: 'tts_standard',
          ttsProviderId: 'openai',
          ttsModelId: 'tts-1',
          ttsVoice: 'alloy',
          ttsApiKey: 'caller-key',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('scopes job status and audio retrieval to the authenticated owner', async () => {
    mocks.read.mockImplementation((_id: string, ownerId: string) =>
      ownerId === 'faculty-a' ? snapshot('completed') : null,
    );
    mocks.result.mockReturnValue({ audio: new Uint8Array([7, 8, 9]), format: 'wav' });
    const context = { params: Promise.resolve({ jobId }) };

    const statusResponse = await getJob(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${jobId}`),
      context,
    );
    expect(statusResponse.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(jobId, 'faculty-a');

    const audioResponse = await getAudio(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${jobId}/audio`),
      context,
    );
    expect(audioResponse.status).toBe(200);
    expect(audioResponse.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await audioResponse.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    expect(mocks.result).toHaveBeenCalledWith(jobId, 'faculty-a');
  });

  it("does not reveal another owner's job", async () => {
    mocks.read.mockReturnValue(null);
    const response = await getJob(
      new NextRequest(`http://localhost/api/generate/tts/jobs/${jobId}`),
      { params: Promise.resolve({ jobId }) },
    );
    expect(response.status).toBe(404);
  });
});
