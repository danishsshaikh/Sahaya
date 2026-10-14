import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type { TeachingVoiceLanguage } from '@/lib/voice-cloning/language';

type ProfileResponse = {
  profile?: PublicVoiceProfile | null;
  error?: string;
};

type FetchLike = typeof fetch;

function normalizeProfileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export class GenerationTeachingVoiceProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationTeachingVoiceProfileError';
  }
}

export async function resolveGenerationTeachingVoiceProfileId(
  selectedProfileId: string | undefined,
  fetchProfile: FetchLike = fetch,
): Promise<string | undefined> {
  const normalizedSelected = normalizeProfileId(selectedProfileId);
  if (normalizedSelected) return normalizedSelected;

  const response = await fetchProfile('/api/voice-cloning/profile?language=en');
  if (!response.ok) return undefined;

  const data = (await response.json().catch(() => null)) as ProfileResponse | null;
  const profile = data?.profile;
  if (profile?.status !== 'ready') return undefined;
  return normalizeProfileId(profile.id);
}

export async function validateGenerationTeachingVoiceProfile(
  selectedProfileId: string,
  lessonLanguage: TeachingVoiceLanguage | null | undefined,
  fetchProfile: FetchLike = fetch,
): Promise<PublicVoiceProfile> {
  const profileId = normalizeProfileId(selectedProfileId);
  if (!profileId) {
    throw new GenerationTeachingVoiceProfileError('Select a ready Teaching Voice profile.');
  }
  if (!lessonLanguage) {
    throw new GenerationTeachingVoiceProfileError(
      'The lesson language is unsupported or ambiguous for Teaching Voice.',
    );
  }

  const query = new URLSearchParams({ profileId, language: lessonLanguage });
  let response: Response;
  try {
    response = await fetchProfile(`/api/voice-cloning/profile?${query}`);
  } catch {
    throw new GenerationTeachingVoiceProfileError(
      'Teaching Voice validation could not be completed. Try again.',
    );
  }
  const data = (await response.json().catch(() => null)) as ProfileResponse | null;
  if (!response.ok || !data?.profile) {
    throw new GenerationTeachingVoiceProfileError(
      data?.error || 'Select a Teaching Voice matching the narration language.',
    );
  }
  return data.profile;
}
