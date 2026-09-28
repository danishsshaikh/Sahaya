import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { measureWavDuration } from '@/lib/audio/audio-duration';
import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';

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
});
