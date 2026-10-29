import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
}));

vi.mock('@/lib/voice-cloning/synthesis', () => ({
  synthesizeFacultyVoice: mocks.synthesize,
}));

import { clearResourceJobQueueForTests } from '@/lib/server/resource-job-queue';
import {
  enqueueTeachingVoiceJob,
  readTeachingVoiceJob,
  readTeachingVoiceJobResult,
  type QueuedTeachingVoiceJobInput,
} from '@/lib/voice-cloning/teaching-voice-jobs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function input(audioId: string, text = `Narration ${audioId}`): QueuedTeachingVoiceJobInput {
  return {
    providerId: 'indicf5',
    ownerId: 'faculty-1',
    profileId: 'vcp_hindi',
    text,
    language: 'hi',
    audioId,
    stageId: 'stage-1',
    outlineId: 'outline-1',
    sceneId: 'scene-1',
  };
}

beforeEach(() => {
  clearResourceJobQueueForTests();
  mocks.synthesize.mockReset();
});

afterEach(() => {
  clearResourceJobQueueForTests();
});

describe('Teaching Voice jobs', () => {
  it('serializes several clips and keeps later clips queued', async () => {
    const first = deferred<{ audio: Uint8Array; format: string }>();
    const second = deferred<{ audio: Uint8Array; format: string }>();
    const third = deferred<{ audio: Uint8Array; format: string }>();
    mocks.synthesize
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);

    const jobs = ['tts_1', 'tts_2', 'tts_3'].map(
      (audioId) => enqueueTeachingVoiceJob(input(audioId)).job,
    );
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(1));
    expect(readTeachingVoiceJob(jobs[0].id, 'faculty-1')?.status).toBe('running');
    expect(readTeachingVoiceJob(jobs[1].id, 'faculty-1')).toMatchObject({
      status: 'queued',
      jobsAhead: 1,
    });

    first.resolve({ audio: new Uint8Array([1]), format: 'wav' });
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(2));
    expect(readTeachingVoiceJobResult(jobs[0].id, 'faculty-1')).toEqual({
      audio: new Uint8Array([1]),
      format: 'wav',
    });
    expect(readTeachingVoiceJob(jobs[1].id, 'faculty-1')?.status).toBe('running');
    expect(readTeachingVoiceJob(jobs[2].id, 'faculty-1')?.status).toBe('queued');

    second.resolve({ audio: new Uint8Array([2]), format: 'wav' });
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(3));
    third.resolve({ audio: new Uint8Array([3]), format: 'wav' });
    await vi.waitFor(() =>
      expect(readTeachingVoiceJob(jobs[2].id, 'faculty-1')?.status).toBe('completed'),
    );
  });

  it('reuses an active or completed job after observer remount', async () => {
    const synthesis = deferred<{ audio: Uint8Array; format: string }>();
    mocks.synthesize.mockReturnValue(synthesis.promise);
    const request = input('tts_stable');

    const first = enqueueTeachingVoiceJob(request);
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(1));
    const activeRetry = enqueueTeachingVoiceJob(request);
    expect(activeRetry).toMatchObject({ reused: true, job: { id: first.job.id } });
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);

    synthesis.resolve({ audio: new Uint8Array([7, 8]), format: 'wav' });
    await vi.waitFor(() =>
      expect(readTeachingVoiceJob(first.job.id, 'faculty-1')?.status).toBe('completed'),
    );
    const completedRetry = enqueueTeachingVoiceJob(request);
    expect(completedRetry).toMatchObject({
      reused: true,
      job: { id: first.job.id, status: 'completed' },
    });
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct speech actions under distinct stable jobs', () => {
    mocks.synthesize.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
    const first = enqueueTeachingVoiceJob(input('tts_action_1', 'Same text'));
    const second = enqueueTeachingVoiceJob(input('tts_action_2', 'Same text'));
    expect(first.job.id).not.toBe(second.job.id);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
  });

  it('isolates Qwen jobs under Qwen resource and provider metadata', async () => {
    mocks.synthesize.mockResolvedValue({ audio: new Uint8Array([4]), format: 'wav' });

    const { job } = enqueueTeachingVoiceJob({
      ...input('tts_qwen', 'Exact Qwen narration'),
      providerId: 'qwen3-tts',
      profileId: 'vcp_english',
      language: 'en',
    });

    expect(job).toMatchObject({
      resourceKey: 'teaching-voice:qwen3-tts',
      metadata: { provider: 'qwen3-tts', profileId: 'vcp_english' },
    });
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledOnce());
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'vcp_english',
        text: 'Exact Qwen narration',
        language: 'en',
      }),
    );
  });

  it('serializes several concurrent Qwen slide jobs in submission order', async () => {
    const gates = [
      deferred<{ audio: Uint8Array; format: string }>(),
      deferred<{ audio: Uint8Array; format: string }>(),
      deferred<{ audio: Uint8Array; format: string }>(),
    ];
    const started: string[] = [];
    mocks.synthesize.mockImplementation((request: { text: string }) => {
      const index = started.length;
      started.push(request.text);
      return gates[index].promise;
    });
    const jobs = ['First slide', 'Second slide', 'Third slide'].map(
      (text, index) =>
        enqueueTeachingVoiceJob({
          ...input(`tts_qwen_${index}`, text),
          providerId: 'qwen3-tts',
          profileId: 'vcp_english',
          language: 'en',
          sceneId: `scene-${index}`,
        }).job,
    );

    await vi.waitFor(() => expect(started).toEqual(['First slide']));
    expect(readTeachingVoiceJob(jobs[1].id, 'faculty-1')).toMatchObject({
      status: 'queued',
      jobsAhead: 1,
    });
    gates[0].resolve({ audio: new Uint8Array([1]), format: 'wav' });
    await vi.waitFor(() => expect(started).toEqual(['First slide', 'Second slide']));
    gates[1].resolve({ audio: new Uint8Array([2]), format: 'wav' });
    await vi.waitFor(() => expect(started).toEqual(['First slide', 'Second slide', 'Third slide']));
    gates[2].resolve({ audio: new Uint8Array([3]), format: 'wav' });
    await vi.waitFor(() =>
      expect(readTeachingVoiceJob(jobs[2].id, 'faculty-1')?.status).toBe('completed'),
    );
  });

  it('retries only a failed Qwen action and preserves completed action audio', async () => {
    mocks.synthesize
      .mockResolvedValueOnce({ audio: new Uint8Array([7]), format: 'wav' })
      .mockRejectedValueOnce(new Error('Qwen capacity wait expired'))
      .mockResolvedValueOnce({ audio: new Uint8Array([9]), format: 'wav' });
    const completed = enqueueTeachingVoiceJob({
      ...input('tts_qwen_complete', 'Completed action'),
      providerId: 'qwen3-tts',
      profileId: 'vcp_english',
      language: 'en',
    }).job;
    const failedRequest = {
      ...input('tts_qwen_failed', 'Retry only this action'),
      providerId: 'qwen3-tts' as const,
      profileId: 'vcp_english',
      language: 'en',
    };
    const failed = enqueueTeachingVoiceJob(failedRequest).job;

    await vi.waitFor(() =>
      expect(readTeachingVoiceJob(failed.id, 'faculty-1')?.status).toBe('failed'),
    );
    expect(readTeachingVoiceJobResult(completed.id, 'faculty-1')).toEqual({
      audio: new Uint8Array([7]),
      format: 'wav',
    });

    const retry = enqueueTeachingVoiceJob(failedRequest);
    expect(retry.reused).toBe(false);
    expect(retry.job.id).not.toBe(failed.id);
    await vi.waitFor(() =>
      expect(readTeachingVoiceJob(retry.job.id, 'faculty-1')?.status).toBe('completed'),
    );
    expect(readTeachingVoiceJobResult(retry.job.id, 'faculty-1')).toEqual({
      audio: new Uint8Array([9]),
      format: 'wav',
    });
    expect(readTeachingVoiceJobResult(completed.id, 'faculty-1')).toEqual({
      audio: new Uint8Array([7]),
      format: 'wav',
    });
  });
});
