import path from 'path';
import { isVoiceCloningEnabled } from '@/lib/config/feature-flags';

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

export function getChatterboxDefaultModelVariant(): string {
  return (process.env.CHATTERBOX_T3_MODEL || 'v3').trim().toLowerCase() || 'v3';
}

export function getTeachingVoiceServiceConfig(provider: 'qwen3' | 'indicf5') {
  const qwen = provider === 'qwen3';
  const baseUrl = qwen
    ? process.env.QWEN3_VOICE_CLONING_BASE_URL || 'http://127.0.0.1:8771'
    : process.env.INDICF5_VOICE_CLONING_BASE_URL || 'http://127.0.0.1:8772';
  const defaultTimeout = qwen ? 600000 : 900000;
  const parsed = Number(
    qwen
      ? process.env.QWEN3_VOICE_CLONING_TIMEOUT_MS || defaultTimeout
      : process.env.INDICF5_VOICE_CLONING_TIMEOUT_MS || defaultTimeout,
  );
  return {
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultTimeout,
  };
}
