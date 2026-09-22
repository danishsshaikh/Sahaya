import { isVoiceCloningServerEnabled } from '@/lib/voice-cloning/config';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import {
  readVoiceProfile,
  referenceAudioExists,
  writeVoiceProfile,
  resolveReferenceAudioPath,
} from '@/lib/voice-cloning/storage';
import { validateTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import { createLogger } from '@/lib/logger';
import {
  isVoiceProviderProfileNotFoundError,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileProvider,
  resolveVoiceProfileModelVariant,
  TeachingVoiceError,
} from '@/lib/voice-cloning/types';

const log = createLogger('VoiceCloningSynthesis');

export async function synthesizeFacultyVoice(input: {
  profileId: string;
  ownerId: string;
  text: string;
  language?: string;
}): Promise<{ audio: Uint8Array; format: string }> {
  if (!isVoiceCloningServerEnabled()) {
    throw new TeachingVoiceError('Voice cloning is disabled.', 403);
  }
  const profile = await readVoiceProfile(input.profileId, input.ownerId);
  if (!profile || profile.ownerId !== input.ownerId || profile.status === 'deleted') {
    throw new TeachingVoiceError('Voice profile not found.', 404);
  }
  if (profile.status !== 'ready' || !profile.providerReferenceId) {
    throw new TeachingVoiceError('Voice profile is not ready.');
  }
  if (!(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new TeachingVoiceError('Voice profile reference audio not found. Re-enroll this voice.');
  }
  const language = validateTeachingVoiceLanguage(profile, input.language);
  const providerId = resolveVoiceProfileProvider(profile);
  const settings = providerId === 'chatterbox' ? {
    modelVariant: resolveVoiceProfileModelVariant(profile),
    generationSettings: resolveVoiceProfileGenerationSettings(profile),
  } : {};
  const provider = getVoiceCloningProvider(providerId);
  const synthesize = async (providerReferenceId: string) => {
    const result = await provider.synthesize({
      providerReferenceId,
      text: input.text,
      language,
      ...settings,
    });
    const mastered = await masterGeneratedVoiceAudio(result.audio, result.format);
    log.info('voice output mastering completed', {
      profileId: profile.id,
      operation: 'synthesize',
      format: mastered.format,
    });
    return mastered;
  };

  try {
    return await synthesize(profile.providerReferenceId);
  } catch (error) {
    if (!isVoiceProviderProfileNotFoundError(error)) {
      throw error;
    }
  }

  const { providerReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey!),
    ...(profile.referenceText ? { referenceText: profile.referenceText } : {}),
    language,
    ...settings,
  });
  if (providerReferenceId !== profile.providerReferenceId) {
    await writeVoiceProfile({
      ...profile,
      providerReferenceId,
      updatedAt: new Date().toISOString(),
    });
  }
  return synthesize(providerReferenceId);
}
