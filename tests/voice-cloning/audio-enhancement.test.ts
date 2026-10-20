import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processChatterboxAudioVariants,
  processVoiceAudioVariants,
} from '@/lib/voice-cloning/audio-enhancement';

const mocks = vi.hoisted(() => ({
  enhance: vi.fn(),
  master: vi.fn(),
}));

vi.mock('@/lib/voice-cloning/resemble-enhance', () => ({
  enhanceGeneratedVoiceAudio: mocks.enhance,
}));
vi.mock('@/lib/voice-cloning/audio-validation', () => ({
  masterGeneratedVoiceAudio: mocks.master,
}));

const raw = { audio: new Uint8Array([1, 2, 3]), format: 'wav' };
const options = {
  context: 'classroom' as const,
  profileId: 'vcp_example',
  languageId: 'en',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.master.mockImplementation(async (audio: Uint8Array, _format: string, preset: string) => ({
    audio: new Uint8Array([...audio, preset === 'chatterbox-enhanced' ? 9 : 4]),
    format: 'wav',
  }));
  mocks.enhance.mockResolvedValue({
    audio: new Uint8Array([7, 8]),
    format: 'wav',
    backend: 'resemble-enhance',
    processingMs: 5,
    originalDurationSeconds: 1,
    enhancedDurationSeconds: 1,
  });
});

describe('Chatterbox enhancement branching', () => {
  it('leaves standard Chatterbox mode on the existing mastering path', async () => {
    const result = await processChatterboxAudioVariants(raw, {
      ...options,
      attemptEnhancement: false,
    });

    expect(mocks.enhance).not.toHaveBeenCalled();
    expect(mocks.master).toHaveBeenCalledExactlyOnceWith(
      raw.audio,
      raw.format,
      'chatterbox-clarity',
    );
    expect(result.enhanced).toBeUndefined();
  });

  it('derives original and enhanced output from the same raw synthesis', async () => {
    const result = await processChatterboxAudioVariants(raw, {
      ...options,
      attemptEnhancement: true,
    });

    expect(mocks.enhance).toHaveBeenCalledExactlyOnceWith(raw);
    expect(mocks.master).toHaveBeenNthCalledWith(1, raw.audio, raw.format, 'chatterbox-clarity');
    expect(mocks.master).toHaveBeenNthCalledWith(
      2,
      new Uint8Array([7, 8]),
      'wav',
      'chatterbox-enhanced',
    );
    expect(result.original.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.enhanced?.audio).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('falls back to mastered original audio when enhancement times out', async () => {
    mocks.enhance.mockRejectedValue(new Error('inference timed out'));

    const result = await processChatterboxAudioVariants(raw, {
      ...options,
      attemptEnhancement: true,
    });

    expect(result.original.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.enhanced).toBeUndefined();
    expect(result.enhancementError).toMatch(/original Chatterbox audio/i);
    expect(mocks.master).toHaveBeenCalledTimes(1);
  });

  it('falls back when enhanced-output validation or mastering fails', async () => {
    mocks.master.mockRejectedValueOnce(new Error('invalid enhanced audio'));

    await expect(
      processChatterboxAudioVariants(raw, { ...options, attemptEnhancement: true }),
    ).rejects.toThrow('invalid enhanced audio');

    mocks.master.mockReset();
    mocks.master
      .mockResolvedValueOnce({ audio: new Uint8Array([4]), format: 'wav' })
      .mockRejectedValueOnce(new Error('enhanced mastering failed'));
    const result = await processChatterboxAudioVariants(raw, {
      ...options,
      attemptEnhancement: true,
    });
    expect(result.original.audio).toEqual(new Uint8Array([4]));
    expect(result.enhanced).toBeUndefined();
  });
});

describe('Qwen3-TTS enhancement branching', () => {
  it('keeps the original Qwen waveform and enhances the same generated sample', async () => {
    const result = await processVoiceAudioVariants(raw, {
      ...options,
      context: 'preview',
      attemptEnhancement: true,
      source: 'qwen3-tts',
      originalMasteringPreset: null,
    });

    expect(result.original).toEqual({ audio: raw.audio, format: 'wav' });
    expect(mocks.enhance).toHaveBeenCalledExactlyOnceWith(raw);
    expect(mocks.master).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([7, 8]),
      'wav',
      'chatterbox-enhanced',
    );
    expect(result.enhanced?.audio).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('preserves the original Qwen preview when enhancement fails', async () => {
    mocks.enhance.mockRejectedValue(new Error('enhancer unavailable'));

    const result = await processVoiceAudioVariants(raw, {
      ...options,
      context: 'preview',
      attemptEnhancement: true,
      source: 'qwen3-tts',
      originalMasteringPreset: null,
    });

    expect(result.original.audio).toBe(raw.audio);
    expect(result.enhanced).toBeUndefined();
    expect(result.enhancementError).toMatch(/original Qwen3-TTS audio/i);
    expect(mocks.master).not.toHaveBeenCalled();
  });
});
