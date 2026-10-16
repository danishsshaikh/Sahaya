import type { PublicVoiceProfile, VoiceEnhancementMode } from '@/lib/voice-cloning/types';
import type { TeachingVoiceLanguage } from '@/lib/voice-cloning/language';

type ProfileResponse = {
  profile?: PublicVoiceProfile | null;
  error?: string;
};

type FetchLike = typeof fetch;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TeachingVoiceSelection {
  enabled: boolean;
  profileId?: string;
  enhancementMode?: VoiceEnhancementMode;
}

const SELECTION_STORAGE_PREFIX = 'sahaya.teachingVoice.selection.v1';

function selectionStorageKey(language: string): string {
  return `${SELECTION_STORAGE_PREFIX}.${language}`;
}

function browserStorage(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function normalizeProfileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function readTeachingVoiceSelection(
  language: string,
  storage: StorageLike | undefined = browserStorage(),
): TeachingVoiceSelection | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(selectionStorageKey(language));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<TeachingVoiceSelection>;
    if (typeof parsed.enabled !== 'boolean') return undefined;
    const profileId = normalizeProfileId(parsed.profileId);
    const enhancementMode =
      parsed.enhancementMode === 'resemble-enhance' ? 'resemble-enhance' : 'standard';
    return {
      enabled: parsed.enabled,
      ...(profileId ? { profileId } : {}),
      ...(parsed.enabled ? { enhancementMode } : {}),
    };
  } catch {
    return undefined;
  }
}

export function persistTeachingVoiceSelection(
  language: string,
  selection: TeachingVoiceSelection,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  storage.setItem(selectionStorageKey(language), JSON.stringify(selection));
}

export function activateTeachingVoiceSelection(
  language: string,
  profileId: string,
  enhancementMode: VoiceEnhancementMode = 'standard',
  storage?: StorageLike,
): void {
  const normalized = normalizeProfileId(profileId);
  if (!normalized) return;
  persistTeachingVoiceSelection(
    language,
    { enabled: true, profileId: normalized, enhancementMode },
    storage,
  );
}

export function disableTeachingVoiceSelection(language: string, storage?: StorageLike): void {
  persistTeachingVoiceSelection(language, { enabled: false }, storage);
}

export function clearTeachingVoiceSelection(
  language: string,
  storage: StorageLike | undefined = browserStorage(),
): void {
  storage?.removeItem(selectionStorageKey(language));
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
  storage: StorageLike | undefined = browserStorage(),
  language = 'en',
): Promise<string | undefined> {
  const normalizedSelected = normalizeProfileId(selectedProfileId);
  if (normalizedSelected) return normalizedSelected;

  const persisted = readTeachingVoiceSelection(language, storage);
  if (persisted?.enabled === false) return undefined;

  const query = new URLSearchParams({ language });
  if (persisted?.profileId) query.set('profileId', persisted.profileId);
  let response: Response;
  try {
    response = await fetchProfile(`/api/voice-cloning/profile?${query}`);
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const data = (await response.json().catch(() => null)) as ProfileResponse | null;
  const profile = data?.profile;
  if (profile?.status !== 'ready') return undefined;
  const profileId = normalizeProfileId(profile.id);
  if (!profileId) return undefined;
  activateTeachingVoiceSelection(
    language,
    profileId,
    profile.enhancementMode ?? 'standard',
    storage,
  );
  return profileId;
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
