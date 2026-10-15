import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { measureWavDuration } from '@/lib/audio/audio-duration';
import {
  masterGeneratedVoiceAudio,
  normalizeVoiceEnrollmentRecording,
  validateEnhancedVoiceAudio,
} from '@/lib/voice-cloning/audio-validation';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error === undefined;

function synthesizeSegmentedWav(
  segments: Array<{ seconds: number; amplitude: number; frequency?: number }>,
  sampleRate = 24_000,
): Uint8Array {
  const frames = segments.reduce(
    (sum, segment) => sum + Math.round(segment.seconds * sampleRate),
    0,
  );
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);

  let frame = 0;
  for (const segment of segments) {
    const frequency = segment.frequency ?? 220;
    const segmentFrames = Math.round(segment.seconds * sampleRate);
    for (let i = 0; i < segmentFrames; i += 1) {
      const value =
        segment.amplitude === 0
          ? 0
          : Math.round(
              Math.sin((2 * Math.PI * frequency * (frame + i)) / sampleRate) * segment.amplitude,
            );
      wav.writeInt16LE(value, 44 + (frame + i) * 2);
    }
    frame += segmentFrames;
  }

  return new Uint8Array(wav);
}

describe.skipIf(!ffmpegAvailable)('masterGeneratedVoiceAudio', () => {
  it('preserves complete IndicF5 timing while producing mono 24 kHz PCM16', async () => {
    const raw = synthesizeSegmentedWav(
      [
        { seconds: 0.3, amplitude: 0 },
        { seconds: 0.5, amplitude: 8_000 },
        { seconds: 0.4, amplitude: 0 },
        { seconds: 0.5, amplitude: 8_000, frequency: 260 },
        { seconds: 0.3, amplitude: 0 },
      ],
      44_100,
    );

    const mastered = await masterGeneratedVoiceAudio(raw, 'wav', 'indicf5-natural');
    const wav = Buffer.from(mastered.audio);

    expect(measureWavDuration(mastered.audio)).toBeCloseTo(2, 1);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('keeps a quiet final voiced tail before trimming only trailing silence', async () => {
    const raw = synthesizeSegmentedWav([
      { seconds: 0.4, amplitude: 12_000 },
      // Models can render final consonants at a much lower level than vowels.
      // This represents the tail of "framework" before actual trailing silence.
      { seconds: 0.28, amplitude: 95, frequency: 170 },
      { seconds: 0.35, amplitude: 0 },
    ]);

    const mastered = await masterGeneratedVoiceAudio(raw, 'wav');
    const duration = measureWavDuration(mastered.audio);

    expect(duration).toBeGreaterThanOrEqual(0.62);
    expect(duration).toBeLessThan(0.9);
  });

  it('produces valid, unclipped Chatterbox clarity-mastered PCM', async () => {
    const raw = synthesizeSegmentedWav([
      { seconds: 0.2, amplitude: 0 },
      { seconds: 0.8, amplitude: 30_000, frequency: 240 },
      { seconds: 0.2, amplitude: 0 },
    ]);

    const mastered = await masterGeneratedVoiceAudio(raw, 'wav', 'chatterbox-clarity');
    expect(Buffer.from(mastered.audio.subarray(0, 4)).toString('ascii')).toBe('RIFF');
    expect(measureWavDuration(mastered.audio)).toBeGreaterThan(0.7);

    const pcm = Buffer.from(mastered.audio);
    let peak = 0;
    for (let offset = 44; offset + 1 < pcm.length; offset += 2) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(32_767);
  });

  it('validates and converts enhanced output to Sahaya mono WAV', async () => {
    const original = synthesizeSegmentedWav([{ seconds: 1, amplitude: 10_000 }], 24_000);
    const enhanced = synthesizeSegmentedWav([{ seconds: 1, amplitude: 8_000 }], 44_100);

    await expect(
      validateEnhancedVoiceAudio({
        originalAudio: original,
        originalFormat: 'wav',
        enhancedAudio: enhanced,
        enhancedFormat: 'wav',
      }),
    ).resolves.toMatchObject({ originalDurationSeconds: 1, enhancedDurationSeconds: 1 });

    const mastered = await masterGeneratedVoiceAudio(enhanced, 'wav', 'chatterbox-enhanced');
    const wav = Buffer.from(mastered.audio);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
  });

  it('rejects enhanced output with an unexpected duration change', async () => {
    const original = synthesizeSegmentedWav([{ seconds: 1, amplitude: 10_000 }]);
    const enhanced = synthesizeSegmentedWav([{ seconds: 1.5, amplitude: 8_000 }]);

    await expect(
      validateEnhancedVoiceAudio({
        originalAudio: original,
        originalFormat: 'wav',
        enhancedAudio: enhanced,
        enhancedFormat: 'wav',
      }),
    ).rejects.toThrow(/duration changed unexpectedly/i);
  });

  it('rejects an all-silent generated clip without returning corrupt audio', async () => {
    const silence = synthesizeSegmentedWav([{ seconds: 0.8, amplitude: 0 }]);
    await expect(masterGeneratedVoiceAudio(silence, 'wav', 'chatterbox-clarity')).rejects.toThrow();
  });
});

describe.skipIf(!ffmpegAvailable)('normalizeVoiceEnrollmentRecording', () => {
  it('keeps the full IndicF5 reference while converting only its transport format', async () => {
    const recording = synthesizeSegmentedWav(
      [
        { seconds: 0.25, amplitude: 0 },
        { seconds: 1.5, amplitude: 6_000 },
        { seconds: 0.25, amplitude: 0 },
      ],
      44_100,
    );

    const normalized = await normalizeVoiceEnrollmentRecording(
      { bytes: recording, mimeType: 'audio/wav', fileName: 'reference.wav' },
      'indicf5-natural',
    );
    const wav = Buffer.from(normalized.referenceAudio);

    expect(normalized.durationSeconds).toBeCloseTo(2, 1);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(normalized.qualityDecision.severity).toBe('pass');
  });
});
