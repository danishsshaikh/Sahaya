import { describe, expect, it } from 'vitest';
import {
  concatenatePcmWav,
  readWavMetadata,
  splitSpeechText,
  splitSpeechTextPreservingText,
} from '@/lib/voice-comparison/audio';

function pcmWav(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

describe('voice comparison audio', () => {
  it('splits long speech at sentence boundaries without changing order', () => {
    expect(splitSpeechText('First sentence. Second sentence! Third sentence?', 32)).toEqual([
      'First sentence. Second sentence!',
      'Third sentence?',
    ]);
  });

  it('splits course narration without changing any transcript character', () => {
    const text = '  First sentence.  Second sentence keeps spacing!  ';
    const chunks = splitSpeechTextPreservingText(text, 22);

    expect(chunks.every((chunk) => chunk.length <= 22)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('concatenates compatible PCM WAV responses and reports duration', () => {
    const combined = concatenatePcmWav([pcmWav([1, 2]), pcmWav([3, 4, 5])]);
    const metadata = readWavMetadata(combined);
    expect(metadata.dataLength).toBe(10);
    expect(metadata.sampleRate).toBe(24000);
    expect(metadata.durationSeconds).toBeCloseTo(5 / 24000);
  });

  it('rejects incompatible or malformed provider audio', () => {
    expect(() => readWavMetadata(new Uint8Array([1, 2, 3]))).toThrow('invalid WAV');
  });
});
