import { TeachingVoiceError } from '@/lib/voice-cloning/types';

export const MAX_COMPARISON_TEXT_CHARACTERS = 3000;
export const MAX_COMPARISON_AUDIO_BYTES = 12 * 1024 * 1024;

export interface WavMetadata {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationSeconds: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function readWavMetadata(bytes: Uint8Array): WavMetadata {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new TeachingVoiceError('Voice provider returned invalid WAV audio.', 502);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: Omit<WavMetadata, 'dataOffset' | 'dataLength' | 'durationSeconds'> | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkLength > bytes.byteLength) break;
    if (chunkId === 'fmt ' && chunkLength >= 16) {
      format = {
        audioFormat: view.getUint16(chunkDataOffset, true),
        channels: view.getUint16(chunkDataOffset + 2, true),
        sampleRate: view.getUint32(chunkDataOffset + 4, true),
        bitsPerSample: view.getUint16(chunkDataOffset + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataLength = chunkLength;
      break;
    }
    offset = chunkDataOffset + chunkLength + (chunkLength % 2);
  }
  if (!format || dataOffset < 0 || dataLength <= 0) {
    throw new TeachingVoiceError('Voice provider returned incomplete WAV audio.', 502);
  }
  if (format.audioFormat !== 1 || format.channels < 1 || format.bitsPerSample < 8) {
    throw new TeachingVoiceError('Voice provider returned an unsupported WAV format.', 502);
  }
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return {
    ...format,
    dataOffset,
    dataLength,
    durationSeconds: dataLength / bytesPerSecond,
  };
}

export function concatenatePcmWav(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) throw new TeachingVoiceError('Voice preview returned no audio.', 502);
  if (parts.length === 1) {
    readWavMetadata(parts[0]);
    return parts[0];
  }
  const parsed = parts.map((bytes) => ({ bytes, metadata: readWavMetadata(bytes) }));
  const first = parsed[0].metadata;
  for (const { metadata } of parsed.slice(1)) {
    if (
      metadata.audioFormat !== first.audioFormat ||
      metadata.channels !== first.channels ||
      metadata.sampleRate !== first.sampleRate ||
      metadata.bitsPerSample !== first.bitsPerSample
    ) {
      throw new TeachingVoiceError('Voice provider returned incompatible WAV segments.', 502);
    }
  }
  const dataLength = parsed.reduce((total, part) => total + part.metadata.dataLength, 0);
  if (dataLength + 44 > MAX_COMPARISON_AUDIO_BYTES) {
    throw new TeachingVoiceError('Voice preview audio is too large.', 502);
  }
  const output = new Uint8Array(44 + dataLength);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + dataLength, true);
  output.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, first.audioFormat, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  const blockAlign = first.channels * (first.bitsPerSample / 8);
  view.setUint32(28, first.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, first.bitsPerSample, true);
  output.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, dataLength, true);
  let writeOffset = 44;
  for (const { bytes, metadata } of parsed) {
    output.set(
      bytes.subarray(metadata.dataOffset, metadata.dataOffset + metadata.dataLength),
      writeOffset,
    );
    writeOffset += metadata.dataLength;
  }
  return output;
}

export function splitSpeechText(text: string, maxChunkCharacters: number): string[] {
  const value = text.trim();
  if (!value) throw new TeachingVoiceError('Enter text to compare.');
  if (value.length > MAX_COMPARISON_TEXT_CHARACTERS) {
    throw new TeachingVoiceError(
      `Comparison text must be ${MAX_COMPARISON_TEXT_CHARACTERS} characters or fewer.`,
    );
  }
  if (value.length <= maxChunkCharacters) return [value];

  const sentences = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(value),
    ({ segment }) => segment.trim(),
  ).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChunkCharacters) {
      const candidate = chunks.at(-1) ? `${chunks.at(-1)} ${sentence}` : sentence;
      if (candidate.length <= maxChunkCharacters && chunks.length > 0) {
        chunks[chunks.length - 1] = candidate;
      } else {
        chunks.push(sentence);
      }
      continue;
    }
    const words = sentence.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (word.length > maxChunkCharacters) {
        throw new TeachingVoiceError('Comparison text contains a word that is too long.');
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChunkCharacters) {
        chunks.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
  }
  if (chunks.length > 8)
    throw new TeachingVoiceError('Comparison text requires too many segments.');
  return chunks;
}
