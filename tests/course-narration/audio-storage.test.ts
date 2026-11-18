import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  putAsset: vi.fn(),
  putRecord: vi.fn(),
}));

vi.mock('@/lib/media/asset-pool', () => ({ putAsset: mocks.putAsset }));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: () => true,
}));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { put: mocks.putRecord } },
}));

import { storeCourseNarrationAudio } from '@/lib/course-narration/audio-storage';

describe('course narration audio storage', () => {
  beforeEach(() => {
    mocks.putAsset.mockReset().mockResolvedValue('ast_raw_provider_audio');
    mocks.putRecord.mockReset().mockResolvedValue(undefined);
  });

  it('stores the base64-decoded provider bytes without re-encoding or signal processing', async () => {
    const source = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
    await storeCourseNarrationAudio({
      stageId: 'course-1',
      versionId: 'sarvam-raw',
      sceneId: 'scene-1',
      actionId: 'speech-1',
      text: 'Exact text',
      format: 'wav',
      base64: Buffer.from(source).toString('base64'),
      durationSeconds: 1.25,
    });

    const uploaded = mocks.putAsset.mock.calls[0]?.[0] as Blob;
    const cached = mocks.putRecord.mock.calls[0]?.[0].blob as Blob;
    const digest = (bytes: ArrayBuffer) =>
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    const expected = createHash('sha256').update(source).digest('hex');
    expect(digest(await uploaded.arrayBuffer())).toBe(expected);
    expect(digest(await cached.arrayBuffer())).toBe(expected);
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    expect(mocks.putRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ast_raw_provider_audio', format: 'wav', text: 'Exact text' }),
    );
  });
});
