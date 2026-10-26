import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireSessionUser: vi.fn(),
  resolveSelection: vi.fn(),
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
  resolveFacultyVoiceSelection: mocks.resolveSelection,
  synthesizeFacultyVoice: mocks.synthesize,
}));
vi.mock('@/lib/voice-cloning/teaching-voice-jobs', () => ({
  enqueueTeachingVoiceJob: mocks.enqueue,
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

function postRequest(language = 'en') {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Narration',
      audioId: 'tts_s1_action-1',
      teacherVoiceProfileId: 'vcp_faculty',
      ttsLanguageCode: language,
      stageId: 'stage-1',
      sceneId: 'scene-1',
    }),
  });
}

function snapshot(status: 'queued' | 'running' | 'completed' = 'queued') {
  return {
    id: jobId,
    resourceKey: 'teaching-voice:chatterbox',
    status,
    enqueuedAt: 1,
    queuePosition: status === 'queued' ? 2 : null,
    jobsAhead: status === 'queued' ? 1 : null,
    queueDepth: 2,
    estimatedWaitMs: status === 'queued' ? 90_000 : null,
    attemptCount: status === 'running' ? 1 : 0,
    metadata: { provider: 'chatterbox' },
  };
}

describe('Teaching Voice async TTS routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSessionUser.mockResolvedValue(user);
    mocks.resolveSelection.mockResolvedValue({ providerId: 'chatterbox', synthesisLanguage: 'hi' });
    mocks.enqueue.mockReturnValue({ job: snapshot(), reused: false });
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([4, 5]), format: 'mp3' });
  });

  it('returns Chatterbox queue admission immediately as HTTP 202', async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      async: true,
      teachingVoiceProvider: 'chatterbox',
      jobId,
      status: 'queued',
      queuePosition: 2,
      jobsAhead: 1,
      estimatedWaitMs: 90_000,
      statusUrl: `/api/generate/tts/jobs/${jobId}`,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'faculty-a',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        text: 'Narration',
        language: 'hi',
      }),
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

  it('admits Indic Teaching Voice to its recoverable queue', async () => {
    mocks.resolveSelection.mockResolvedValue({ providerId: 'indicf5', synthesisLanguage: 'hi' });
    mocks.enqueue.mockReturnValue({
      job: { ...snapshot(), resourceKey: 'teaching-voice:indicf5' },
      reused: false,
    });
    const response = await POST(postRequest('hi'));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      async: true,
      status: 'queued',
      teachingVoiceProvider: 'indicf5',
    });
    expect(mocks.resolveSelection).toHaveBeenCalledWith('vcp_faculty', 'faculty-a', 'hi');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'indicf5', language: 'hi' }),
    );
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('rejects prose in the Teaching Voice language transport', async () => {
    const response = await POST(postRequest('Deliver the entire course in Hindi'));
    expect(response.status).toBe(400);
    expect(mocks.resolveSelection).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not send Standard Voice through the Chatterbox resource queue', async () => {
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
