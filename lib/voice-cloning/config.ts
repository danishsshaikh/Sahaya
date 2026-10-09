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

export function getTeachingVoiceServiceConfig(_provider: 'indicf5') {
  const baseUrl = process.env.INDICF5_VOICE_CLONING_BASE_URL || 'http://127.0.0.1:8772';
  const defaultTimeout = 900000;
  const parsed = Number(process.env.INDICF5_VOICE_CLONING_TIMEOUT_MS || defaultTimeout);
  return {
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultTimeout,
  };
}
