import { getVoiceCloningProviderId } from '@/lib/voice-cloning/config';
import type { VoiceCloningProvider } from '@/lib/voice-cloning/types';
import { ChatterboxVoiceCloningProvider } from '@/lib/voice-cloning/providers/chatterbox';
import { IndicF5VoiceCloningProvider } from './providers/indicf5';
import { TeachingVoiceError } from './types';

export function getVoiceCloningProvider(
  provider = getVoiceCloningProviderId(),
): VoiceCloningProvider {
  if (provider === 'chatterbox') return new ChatterboxVoiceCloningProvider();
  if (provider === 'indicf5') return new IndicF5VoiceCloningProvider();
  throw new TeachingVoiceError('Unsupported Teaching Voice provider.');
}
