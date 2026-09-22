import { getVoiceCloningProviderId } from '@/lib/voice-cloning/config';
import type { VoiceCloningProvider } from '@/lib/voice-cloning/types';
import { ChatterboxVoiceCloningProvider } from '@/lib/voice-cloning/providers/chatterbox';
import { Qwen3VoiceCloningProvider } from './providers/qwen3';
import { IndicF5VoiceCloningProvider } from './providers/indicf5';
import { TeachingVoiceError } from './types';

export function getVoiceCloningProvider(provider = getVoiceCloningProviderId()): VoiceCloningProvider {
  if (provider === 'chatterbox') return new ChatterboxVoiceCloningProvider();
  if (provider === 'qwen3') return new Qwen3VoiceCloningProvider();
  if (provider === 'indicf5') return new IndicF5VoiceCloningProvider();
  throw new TeachingVoiceError('Unsupported Teaching Voice provider.');
}
