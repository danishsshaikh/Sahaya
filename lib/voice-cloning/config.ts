import path from 'path';
import { isVoiceCloningEnabled } from '@/lib/config/feature-flags';
import {
  DEFAULT_CHATTERBOX_MODEL_VARIANT,
  isChatterboxModelVariant,
  type ChatterboxModelVariant,
} from '@/lib/voice-cloning/types';

export function isVoiceCloningServerEnabled(): boolean {
  return isVoiceCloningEnabled();
}

export function getVoiceCloningProviderId(): string {
  return (process.env.VOICE_CLONING_PROVIDER || 'chatterbox').trim().toLowerCase();
}

export function getVoiceCloningBaseUrl(): string {
  return (process.env.VOICE_CLONING_BASE_URL || '').trim().replace(/\/$/, '');
}

export function getVoiceCloningStorageDir(): string {
  const configured = process.env.VOICE_CLONING_STORAGE_DIR?.trim();
  return configured || path.join(process.cwd(), 'data', 'voice-cloning');
}

export function getVoiceCloningDefaultLanguage(): string {
  return (process.env.VOICE_CLONING_LANGUAGE_DEFAULT || 'en').trim() || 'en';
}

export function getVoiceCloningTimeoutMs(): number {
  const parsed = Number(process.env.VOICE_CLONING_TIMEOUT_MS || 120000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120000;
}

export function getChatterboxDefaultModelVariant(): ChatterboxModelVariant {
  const configured = (process.env.CHATTERBOX_T3_MODEL || '').trim().toLowerCase();
  return isChatterboxModelVariant(configured) ? configured : DEFAULT_CHATTERBOX_MODEL_VARIANT;
}

export type VoiceEnhancementSurface = 'preview' | 'classroom';

export interface VoiceEnhancementConfig {
  enabled: boolean;
  backend: 'resemble-enhance';
  previewEnabled: boolean;
  classroomEnabled: boolean;
  hindiEnabled: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  pythonExecutable: string;
  workerPath: string;
  device: string;
  nfe: number;
  solver: 'midpoint' | 'rk4' | 'euler';
  denoiseStrength: number;
  priorTemperature: number;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function getVoiceEnhancementConfig(): VoiceEnhancementConfig {
  const backend = (process.env.VOICE_ENHANCEMENT_BACKEND || 'resemble-enhance')
    .trim()
    .toLowerCase();
  if (backend !== 'resemble-enhance') {
    throw new Error(`Unsupported voice enhancement backend: ${backend}`);
  }
  const solverValue = (process.env.RESEMBLE_ENHANCE_SOLVER || 'midpoint').trim().toLowerCase();
  const solver =
    solverValue === 'rk4' || solverValue === 'euler' || solverValue === 'midpoint'
      ? solverValue
      : 'midpoint';
  return {
    enabled: envFlag('VOICE_ENHANCEMENT_ENABLED', false),
    backend,
    previewEnabled: envFlag('VOICE_ENHANCEMENT_PREVIEW_ENABLED', true),
    classroomEnabled: envFlag('VOICE_ENHANCEMENT_CLASSROOM_ENABLED', false),
    hindiEnabled: envFlag('VOICE_ENHANCEMENT_HINDI_ENABLED', false),
    timeoutMs: Math.floor(boundedNumber('VOICE_ENHANCEMENT_TIMEOUT_MS', 120000, 1000, 900000)),
    maxConcurrency: Math.floor(boundedNumber('VOICE_ENHANCEMENT_MAX_CONCURRENCY', 1, 1, 4)),
    pythonExecutable: process.env.RESEMBLE_ENHANCE_PYTHON?.trim() || 'python3',
    workerPath:
      process.env.RESEMBLE_ENHANCE_WORKER_PATH?.trim() ||
      path.join(process.cwd(), 'services', 'resemble-enhance', 'worker.py'),
    device: process.env.RESEMBLE_ENHANCE_DEVICE?.trim() || 'cuda',
    nfe: Math.floor(boundedNumber('RESEMBLE_ENHANCE_NFE', 32, 1, 128)),
    solver,
    denoiseStrength: boundedNumber('RESEMBLE_ENHANCE_DENOISE_STRENGTH', 0.1, 0, 1),
    priorTemperature: boundedNumber('RESEMBLE_ENHANCE_PRIOR_TEMPERATURE', 0.5, 0, 1),
  };
}

export function isVoiceEnhancementAllowed(
  languageId: string,
  surface: VoiceEnhancementSurface,
): boolean {
  const config = getVoiceEnhancementConfig();
  if (!config.enabled) return false;
  if (surface === 'preview' && !config.previewEnabled) return false;
  if (surface === 'classroom' && !config.classroomEnabled) return false;
  return languageId !== 'hi' || config.hindiEnabled;
}

export function getTeachingVoiceServiceConfig(_provider: 'indicf5') {
  const baseUrl = process.env.INDICF5_VOICE_CLONING_BASE_URL || 'http://127.0.0.1:8772';
  const defaultTimeout = 900000;
  const parsed = Number(process.env.INDICF5_VOICE_CLONING_TIMEOUT_MS || defaultTimeout);
  return {
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultTimeout,
  };
}
