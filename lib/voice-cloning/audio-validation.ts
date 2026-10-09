import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  MAX_RECORDING_DURATION_SECONDS,
  MAX_RECORDING_SIZE_BYTES,
  MIN_RECORDING_DURATION_SECONDS,
  MIN_RECORDING_SIZE_BYTES,
} from '@/lib/voice-cloning/limits';

const execFileAsync = promisify(execFile);

export const VOICE_REFERENCE_SAMPLE_RATE = 24000;

export const VOICE_AUDIO_PROCESSING_CONFIG = {
  referenceSampleRate: VOICE_REFERENCE_SAMPLE_RATE,
  silenceThresholdDb: -45,
  maxSilenceRatio: 0.55,
  tooQuietMeanVolumeDb: -42,
  tooQuietPeakVolumeDb: -30,
  nearSilentMeanVolumeDb: -52,
  nearSilentPeakVolumeDb: -42,
  hotPeakWarningDb: -0.5,
  hotMeanVolumeWarningDb: -14,
  clippingSampleAmplitude: 0.999,
  clippingWarningSampleRatio: 0.0005,
  clippingRejectSampleRatio: 0.015,
  clippingWarningConsecutiveMs: 3,
  clippingRejectConsecutiveMs: 25,
  referenceLoudnessTarget: -20,
  referencePeakCeiling: -2.5,
  outputLoudnessTarget: -18,
  outputPeakCeiling: -2,
  outputLimiterLevel: 0.95,
  generatedSilenceThresholdDb: -60,
  generatedTrailingSilenceSeconds: 0.18,
  // Conservative denoising only. Stronger cleanup can damage speaker identity
  // and does not guarantee accent or speaker-similarity improvements.
  referenceDenoiseNoiseFloorDb: -28,
} as const;

const REFERENCE_PREPROCESSING_FILTER = [
  `silenceremove=start_periods=1:start_duration=0.25:start_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.silenceThresholdDb}dB`,
  'areverse',
  `silenceremove=start_periods=1:start_duration=0.25:start_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.silenceThresholdDb}dB`,
  'areverse',
  `afftdn=nf=${VOICE_AUDIO_PROCESSING_CONFIG.referenceDenoiseNoiseFloorDb}`,
  `loudnorm=I=${VOICE_AUDIO_PROCESSING_CONFIG.referenceLoudnessTarget}:TP=${VOICE_AUDIO_PROCESSING_CONFIG.referencePeakCeiling}:LRA=12`,
  `alimiter=limit=${VOICE_AUDIO_PROCESSING_CONFIG.outputLimiterLevel}`,
].join(',');

const GENERATED_AUDIO_MASTERING_FILTER = [
  [
    'silenceremove=start_periods=1:start_duration=0.2',
    `start_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.generatedSilenceThresholdDb}dB`,
    'stop_periods=-1:stop_duration=0.2',
    `stop_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.generatedSilenceThresholdDb}dB`,
    `stop_silence=${VOICE_AUDIO_PROCESSING_CONFIG.generatedTrailingSilenceSeconds}`,
  ].join(':'),
  `loudnorm=I=${VOICE_AUDIO_PROCESSING_CONFIG.outputLoudnessTarget}:TP=${VOICE_AUDIO_PROCESSING_CONFIG.outputPeakCeiling}:LRA=11`,
  `alimiter=limit=${VOICE_AUDIO_PROCESSING_CONFIG.outputLimiterLevel}`,
].join(',');

const CHATTERBOX_CLARITY_MASTERING_FILTER = [
  [
    'silenceremove=start_periods=1:start_duration=0.2',
    `start_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.generatedSilenceThresholdDb}dB`,
    'stop_periods=-1:stop_duration=0.2',
    `stop_threshold=${VOICE_AUDIO_PROCESSING_CONFIG.generatedSilenceThresholdDb}dB`,
    `stop_silence=${VOICE_AUDIO_PROCESSING_CONFIG.generatedTrailingSilenceSeconds}`,
  ].join(':'),
  'highpass=f=70',
  'equalizer=f=250:t=q:w=1:g=-1.5',
  'equalizer=f=3000:t=q:w=1:g=1.25',
  'acompressor=threshold=0.125:ratio=2:attack=20:release=200:makeup=1.1',
  `loudnorm=I=${VOICE_AUDIO_PROCESSING_CONFIG.outputLoudnessTarget}:TP=${VOICE_AUDIO_PROCESSING_CONFIG.outputPeakCeiling}:LRA=11`,
  `alimiter=limit=${VOICE_AUDIO_PROCESSING_CONFIG.outputLimiterLevel}`,
].join(',');

export type GeneratedVoiceMasteringPreset = 'standard' | 'chatterbox-clarity';

export const SUPPORTED_RECORDING_MIME_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);

export type VoiceRecordingQualityCode =
  | 'decode_failed'
  | 'too_short'
  | 'too_long'
  | 'too_quiet'
  | 'too_much_silence'
  | 'clipped'
  | 'empty';

export type VoiceRecordingQualitySeverity = 'pass' | 'warning' | 'reject';

export interface VoiceRecordingQualityDecision {
  severity: VoiceRecordingQualitySeverity;
  code?: VoiceRecordingQualityCode;
  userMessage?: string;
  warnings: string[];
}

export class VoiceRecordingQualityError extends Error {
  readonly code: VoiceRecordingQualityCode;
  readonly userMessage: string;
  readonly decision?: VoiceRecordingQualityDecision;
  readonly metrics?: VoiceRecordingQualityMetrics;

  constructor(
    code: VoiceRecordingQualityCode,
    userMessage: string,
    details?: string,
    decision?: VoiceRecordingQualityDecision,
    metrics?: VoiceRecordingQualityMetrics,
  ) {
    super(details || userMessage);
    this.name = 'VoiceRecordingQualityError';
    this.code = code;
    this.userMessage = userMessage;
    this.decision = decision;
    this.metrics = metrics;
  }
}

export function isVoiceRecordingQualityError(error: unknown): error is VoiceRecordingQualityError {
  return (
    error instanceof VoiceRecordingQualityError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'VoiceRecordingQualityError')
  );
}

export interface IncomingVoiceClip {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface VoiceRecordingQualityMetrics {
  durationSeconds: number;
  meanVolumeDb: number;
  maxVolumeDb: number;
  silenceSeconds: number;
  silenceRatio: number;
  clippedSampleRatio: number;
  maxConsecutiveClippingMs: number;
  clippedSampleCount: number;
  totalSampleCount: number;
}

export interface NormalizedVoiceReference {
  referenceAudio: Uint8Array;
  durationSeconds: number;
  quality: VoiceRecordingQualityMetrics;
  qualityDecision: VoiceRecordingQualityDecision;
  format: 'wav';
}

export function validateIncomingClipMetadata(clip: IncomingVoiceClip): void {
  const mimeType = clip.mimeType.toLowerCase();
  if (!SUPPORTED_RECORDING_MIME_TYPES.has(mimeType)) {
    throw new VoiceRecordingQualityError(
      'decode_failed',
      'The recording could not be read. Please try recording again.',
      `Unsupported audio type: ${clip.mimeType || 'unknown'}`,
    );
  }
  if (clip.bytes.byteLength < MIN_RECORDING_SIZE_BYTES) {
    throw new VoiceRecordingQualityError(
      'empty',
      'The recording appears empty. Please check your microphone and try again.',
    );
  }
  if (clip.bytes.byteLength > MAX_RECORDING_SIZE_BYTES) {
    throw new VoiceRecordingQualityError(
      'too_long',
      'The recording is too large. Please record a shorter sample.',
    );
  }
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'wav';
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('invalid duration');
    }
    return duration;
  } catch (error) {
    throw new VoiceRecordingQualityError(
      'decode_failed',
      'The recording could not be read. Please try recording again.',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseDbValue(report: string, label: string): number | null {
  const match = new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*dB`).exec(report);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseTotalSilenceSeconds(report: string): number {
  const matches = report.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g);
  let total = 0;
  for (const match of matches) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

export function qualityMetricsFromFfmpegReports(input: {
  durationSeconds: number;
  volumeReport: string;
  silenceReport: string;
  clipping?: Partial<
    Pick<
      VoiceRecordingQualityMetrics,
      'clippedSampleRatio' | 'maxConsecutiveClippingMs' | 'clippedSampleCount' | 'totalSampleCount'
    >
  >;
}): VoiceRecordingQualityMetrics {
  const meanVolumeDb = parseDbValue(input.volumeReport, 'mean_volume');
  const maxVolumeDb = parseDbValue(input.volumeReport, 'max_volume');
  if (meanVolumeDb === null || maxVolumeDb === null) {
    throw new VoiceRecordingQualityError(
      'decode_failed',
      'The recording could not be analyzed. Please try recording again.',
    );
  }
  const silenceSeconds = parseTotalSilenceSeconds(input.silenceReport);
  return {
    durationSeconds: input.durationSeconds,
    meanVolumeDb,
    maxVolumeDb,
    silenceSeconds,
    silenceRatio: input.durationSeconds > 0 ? silenceSeconds / input.durationSeconds : 1,
    clippedSampleRatio: input.clipping?.clippedSampleRatio ?? 0,
    maxConsecutiveClippingMs: input.clipping?.maxConsecutiveClippingMs ?? 0,
    clippedSampleCount: input.clipping?.clippedSampleCount ?? 0,
    totalSampleCount: input.clipping?.totalSampleCount ?? 0,
  };
}

function rejectDecision(
  code: VoiceRecordingQualityCode,
  userMessage: string,
): VoiceRecordingQualityDecision {
  return {
    severity: 'reject',
    code,
    userMessage,
    warnings: [],
  };
}

export function decideVoiceRecordingQuality(
  metrics: VoiceRecordingQualityMetrics,
): VoiceRecordingQualityDecision {
  if (metrics.durationSeconds < MIN_RECORDING_DURATION_SECONDS) {
    return rejectDecision(
      'too_short',
      'The recording appears empty. Please check your microphone and try again.',
    );
  }
  if (metrics.durationSeconds > MAX_RECORDING_DURATION_SECONDS) {
    return rejectDecision(
      'too_long',
      'The recording is too long to process. Please record the paragraph once at a natural pace.',
    );
  }
  if (
    metrics.meanVolumeDb <= VOICE_AUDIO_PROCESSING_CONFIG.nearSilentMeanVolumeDb ||
    metrics.maxVolumeDb <= VOICE_AUDIO_PROCESSING_CONFIG.nearSilentPeakVolumeDb
  ) {
    return rejectDecision(
      'too_quiet',
      'The recording is too quiet to use. Please try again a little closer to your microphone.',
    );
  }
  if (metrics.silenceRatio >= VOICE_AUDIO_PROCESSING_CONFIG.maxSilenceRatio) {
    return rejectDecision(
      'too_much_silence',
      'The recording contains too much silence. Please read the full paragraph naturally.',
    );
  }
  if (
    metrics.clippedSampleRatio >= VOICE_AUDIO_PROCESSING_CONFIG.clippingRejectSampleRatio ||
    metrics.maxConsecutiveClippingMs >= VOICE_AUDIO_PROCESSING_CONFIG.clippingRejectConsecutiveMs
  ) {
    return rejectDecision(
      'clipped',
      'The recording has sustained distortion. Please record again at a normal speaking volume with a little more distance from the microphone.',
    );
  }

  const warnings: string[] = [];
  if (
    metrics.meanVolumeDb <= VOICE_AUDIO_PROCESSING_CONFIG.tooQuietMeanVolumeDb ||
    metrics.maxVolumeDb <= VOICE_AUDIO_PROCESSING_CONFIG.tooQuietPeakVolumeDb
  ) {
    warnings.push('The recording is quiet, but still usable.');
  }
  if (
    metrics.maxVolumeDb >= VOICE_AUDIO_PROCESSING_CONFIG.hotPeakWarningDb ||
    metrics.meanVolumeDb >= VOICE_AUDIO_PROCESSING_CONFIG.hotMeanVolumeWarningDb ||
    metrics.clippedSampleRatio >= VOICE_AUDIO_PROCESSING_CONFIG.clippingWarningSampleRatio ||
    metrics.maxConsecutiveClippingMs >= VOICE_AUDIO_PROCESSING_CONFIG.clippingWarningConsecutiveMs
  ) {
    warnings.push('The recording is a little loud, but still usable.');
  }

  return {
    severity: warnings.length > 0 ? 'warning' : 'pass',
    warnings,
  };
}

export function evaluateVoiceRecordingQuality(
  metrics: VoiceRecordingQualityMetrics,
): VoiceRecordingQualityDecision {
  const decision = decideVoiceRecordingQuality(metrics);
  if (decision.severity === 'reject') {
    throw new VoiceRecordingQualityError(
      decision.code ?? 'decode_failed',
      decision.userMessage ?? 'The recording could not be used. Please try recording again.',
      undefined,
      decision,
      metrics,
    );
  }
  return decision;
}

async function runFfmpegAnalysis(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', args);
    return stderr;
  } catch (error) {
    throw new VoiceRecordingQualityError(
      'decode_failed',
      'The recording could not be analyzed. Please try recording again.',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function clippingMetricsFromPcmFloat32(
  pcm: Buffer,
  sampleRate = VOICE_REFERENCE_SAMPLE_RATE,
): Pick<
  VoiceRecordingQualityMetrics,
  'clippedSampleRatio' | 'maxConsecutiveClippingMs' | 'clippedSampleCount' | 'totalSampleCount'
> {
  const totalSampleCount = Math.floor(pcm.byteLength / 4);
  if (totalSampleCount <= 0) {
    return {
      clippedSampleRatio: 0,
      maxConsecutiveClippingMs: 0,
      clippedSampleCount: 0,
      totalSampleCount: 0,
    };
  }

  let clippedSampleCount = 0;
  let currentConsecutive = 0;
  let maxConsecutive = 0;
  for (let offset = 0; offset + 3 < pcm.byteLength; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    if (Math.abs(sample) >= VOICE_AUDIO_PROCESSING_CONFIG.clippingSampleAmplitude) {
      clippedSampleCount += 1;
      currentConsecutive += 1;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  return {
    clippedSampleRatio: clippedSampleCount / totalSampleCount,
    maxConsecutiveClippingMs: (maxConsecutive / sampleRate) * 1000,
    clippedSampleCount,
    totalSampleCount,
  };
}

async function analyzeClipping(
  filePath: string,
): Promise<
  Pick<
    VoiceRecordingQualityMetrics,
    'clippedSampleRatio' | 'maxConsecutiveClippingMs' | 'clippedSampleCount' | 'totalSampleCount'
  >
> {
  try {
    const { stdout } = (await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-ac',
        '1',
        '-ar',
        String(VOICE_REFERENCE_SAMPLE_RATE),
        '-f',
        'f32le',
        '-',
      ],
      { encoding: 'buffer', maxBuffer: MAX_RECORDING_SIZE_BYTES * 8 },
    )) as { stdout: Buffer };
    return clippingMetricsFromPcmFloat32(stdout);
  } catch (error) {
    throw new VoiceRecordingQualityError(
      'decode_failed',
      'The recording could not be analyzed. Please try recording again.',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function analyzeVoiceRecordingQuality(
  filePath: string,
): Promise<{ metrics: VoiceRecordingQualityMetrics; decision: VoiceRecordingQualityDecision }> {
  const durationSeconds = await probeDuration(filePath);
  const volumeReport = await runFfmpegAnalysis([
    '-hide_banner',
    '-i',
    filePath,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const silenceReport = await runFfmpegAnalysis([
    '-hide_banner',
    '-i',
    filePath,
    '-af',
    `silencedetect=n=${VOICE_AUDIO_PROCESSING_CONFIG.silenceThresholdDb}dB:d=0.4`,
    '-f',
    'null',
    '-',
  ]);
  const clipping = await analyzeClipping(filePath);
  const metrics = qualityMetricsFromFfmpegReports({
    durationSeconds,
    volumeReport,
    silenceReport,
    clipping,
  });
  const decision = evaluateVoiceRecordingQuality(metrics);
  return { metrics, decision };
}

export async function validateVoiceClipDecodability(filePath: string): Promise<number> {
  const duration = await probeDuration(filePath);
  if (duration < MIN_RECORDING_DURATION_SECONDS) {
    throw new VoiceRecordingQualityError(
      'too_short',
      'The recording appears empty. Please check your microphone and try again.',
    );
  }
  if (duration > MAX_RECORDING_DURATION_SECONDS) {
    throw new VoiceRecordingQualityError(
      'too_long',
      'The recording is too long to process. Please record the paragraph once at a natural pace.',
    );
  }
  return duration;
}

export async function normalizeVoiceEnrollmentRecording(
  recording: IncomingVoiceClip,
): Promise<NormalizedVoiceReference> {
  validateIncomingClipMetadata(recording);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-voice-'));
  try {
    const inputPath = path.join(tempDir, `recording.${extensionForMime(recording.mimeType)}`);
    const outputPath = path.join(tempDir, 'reference.wav');
    await fs.writeFile(inputPath, recording.bytes);

    const { metrics: quality, decision: qualityDecision } =
      await analyzeVoiceRecordingQuality(inputPath);
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      String(VOICE_REFERENCE_SAMPLE_RATE),
      '-af',
      REFERENCE_PREPROCESSING_FILTER,
      outputPath,
    ]);
    const durationSeconds = await validateVoiceClipDecodability(outputPath);
    return {
      referenceAudio: new Uint8Array(await fs.readFile(outputPath)),
      durationSeconds,
      quality,
      qualityDecision,
      format: 'wav',
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function normalizeVoiceEnrollmentClips(clips: IncomingVoiceClip[]): Promise<{
  referenceAudio: Uint8Array;
  durations: number[];
}> {
  if (clips.length !== 1) {
    throw new Error('Exactly one recording is required');
  }
  const normalized = await normalizeVoiceEnrollmentRecording(clips[0]);
  return { referenceAudio: normalized.referenceAudio, durations: [normalized.durationSeconds] };
}

export async function masterGeneratedVoiceAudio(
  audio: Uint8Array,
  format: string,
  preset: GeneratedVoiceMasteringPreset = 'standard',
): Promise<{ audio: Uint8Array; format: 'wav' }> {
  if (audio.byteLength < MIN_RECORDING_SIZE_BYTES) {
    throw new Error('Generated voice audio is empty');
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-voice-output-'));
  try {
    const inputPath = path.join(tempDir, `raw.${extensionForMime(`audio/${format}`)}`);
    const outputPath = path.join(tempDir, 'mastered.wav');
    await fs.writeFile(inputPath, audio);
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      String(VOICE_REFERENCE_SAMPLE_RATE),
      '-af',
      preset === 'chatterbox-clarity'
        ? CHATTERBOX_CLARITY_MASTERING_FILTER
        : GENERATED_AUDIO_MASTERING_FILTER,
      outputPath,
    ]);
    await probeDuration(outputPath);
    return { audio: new Uint8Array(await fs.readFile(outputPath)), format: 'wav' };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
