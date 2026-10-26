export interface ExternalVoiceProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxConcurrency: number;
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function baseUrl(name: string, fallback: string): string {
  return (process.env[name]?.trim() || fallback).replace(/\/$/, '');
}

export function getSarvamVoiceCloningConfig(): ExternalVoiceProviderConfig {
  return {
    enabled: envFlag('SARVAM_VOICE_CLONING_ENABLED'),
    apiKey: process.env.SARVAM_API_KEY?.trim() || '',
    baseUrl: baseUrl('SARVAM_API_BASE_URL', 'https://api.sarvam.ai'),
    timeoutMs: boundedInteger('SARVAM_TIMEOUT_MS', 120000, 1000, 300000),
    maxConcurrency: boundedInteger('SARVAM_MAX_CONCURRENCY', 1, 1, 4),
  };
}

export function getBodhanTtsConfig(): ExternalVoiceProviderConfig {
  return {
    enabled: envFlag('BODHAN_TTS_ENABLED'),
    apiKey: process.env.BODHAN_API_KEY?.trim() || '',
    baseUrl: baseUrl('BODHAN_API_BASE_URL', 'https://api.bodhan.ai/v1'),
    timeoutMs: boundedInteger('BODHAN_TIMEOUT_MS', 120000, 1000, 300000),
    maxConcurrency: boundedInteger('BODHAN_MAX_CONCURRENCY', 2, 1, 4),
  };
}

export function externalVoiceProviderConfigured(config: ExternalVoiceProviderConfig): boolean {
  return config.enabled && config.apiKey.length > 0;
}
