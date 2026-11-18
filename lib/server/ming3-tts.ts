import { createHash } from 'node:crypto';
import { isMing3TtsPreviewEnabled } from '@/lib/voice-cloning/config';
import { resolveAuthorizedProfileReference, writeVoiceProfile } from '@/lib/voice-cloning/storage';
import { getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import { Ming3TtsPreviewProvider } from '@/lib/voice-comparison/providers/ming3';
import {
  TeachingVoiceError,
  type VoicePreview,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import { markVoiceConfigured } from '@/lib/auth/server';

const MING_MAX_TEXT_LENGTH = 1000;

export function ming3ServiceProfileId(profile: VoiceProfile): string {
  return `ming_${createHash('sha256')
    .update(`${profile.ownerId}\0${profile.id}\0${profile.profileVersion}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export async function synthesizeMing3TeachingVoice(input: {
  profile: VoiceProfile;
  text: string;
  signal?: AbortSignal;
  allowPreReadyProfile?: boolean;
}): Promise<{
  audio: Uint8Array;
  format: 'wav';
  durationSeconds: number;
  requestId?: string;
  referenceTransformation?: string;
  conditioningMode?: string;
  generationConfig?: string;
  referenceProvenance: 'original-upload' | 'processed-reference';
}> {
  if (!isMing3TtsPreviewEnabled()) {
    throw new TeachingVoiceError(
      'Ming 3.0 TTS is unavailable because the Ming service is not enabled.',
      503,
    );
  }
  if (input.profile.language !== 'en') {
    throw new TeachingVoiceError('Ming 3.0 TTS currently requires an English Teaching Voice.');
  }
  if (!input.profile.referenceText?.trim()) {
    throw new TeachingVoiceError(
      'Ming 3.0 TTS requires the saved transcript for this Teaching Voice.',
    );
  }
  if (!input.text.trim()) throw new TeachingVoiceError('Enter text to synthesize.');
  if (input.text.length > MING_MAX_TEXT_LENGTH) {
    throw new TeachingVoiceError(
      `Ming 3.0 TTS supports up to ${MING_MAX_TEXT_LENGTH} characters per narration segment.`,
    );
  }

  let reference: Awaited<ReturnType<typeof resolveAuthorizedProfileReference>>;
  try {
    reference = await resolveAuthorizedProfileReference({
      ownerId: input.profile.ownerId,
      profileId: input.profile.id,
      preferOriginalMimeTypes: [
        'audio/wav',
        'audio/x-wav',
        'audio/flac',
        'audio/ogg',
        'audio/opus',
      ],
      allowPreReady: input.allowPreReadyProfile,
    });
  } catch {
    throw new TeachingVoiceError(
      'Ming 3.0 TTS requires a readable reference in your authorized Teaching Voice storage.',
      409,
    );
  }

  const provider = new Ming3TtsPreviewProvider();
  const profileId = ming3ServiceProfileId(input.profile);
  await provider.registerProfile(
    {
      profileId,
      referenceAudioPath: reference.path,
      referenceText: input.profile.referenceText,
    },
    input.signal,
  );
  const result = await provider.synthesize({
    profileId,
    text: input.text,
    language: 'en',
    signal: input.signal,
  });
  return {
    audio: result.audio,
    format: 'wav',
    durationSeconds: result.durationSeconds,
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.referenceTransformation
      ? { referenceTransformation: result.referenceTransformation }
      : {}),
    ...(result.conditioningMode ? { conditioningMode: result.conditioningMode } : {}),
    ...(result.generationConfig ? { generationConfig: result.generationConfig } : {}),
    referenceProvenance: reference.provenance,
  };
}

function previewFromAudio(audio: Uint8Array): VoicePreview {
  return {
    format: 'wav',
    base64: Buffer.from(audio).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export async function activateMing3TeachingVoice(
  profile: VoiceProfile,
  ownerId: string,
  options: { allowPreReadyProfile?: boolean } = {},
): Promise<VoiceProfile> {
  if (profile.ownerId !== ownerId) throw new TeachingVoiceError('Voice profile not found.', 404);
  const result = await synthesizeMing3TeachingVoice({
    profile,
    text: getVoicePreviewText('en', 'ming3-tts'),
    allowPreReadyProfile: options.allowPreReadyProfile,
  });
  const next: VoiceProfile = {
    ...profile,
    status: 'ready',
    activeEngine: 'ming3-tts',
    preview: previewFromAudio(result.audio),
    previewTextLanguageId: 'en',
    previewText: getVoicePreviewText('en', 'ming3-tts'),
    failureReason: undefined,
    failurePhase: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeVoiceProfile(next);
  await markVoiceConfigured(ownerId);
  return next;
}
