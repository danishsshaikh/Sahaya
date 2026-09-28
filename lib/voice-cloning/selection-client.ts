import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';

type ProfileResponse = {
  profile?: PublicVoiceProfile | null;
};

type FetchLike = typeof fetch;

function normalizeProfileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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
