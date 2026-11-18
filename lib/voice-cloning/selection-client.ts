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
  explicitlyDisabled?: boolean;
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

function selectedEnhancementMode(profile: PublicVoiceProfile): VoiceEnhancementMode {
  return profile.activeEngine === 'qwen3-tts'
    ? (profile.qwenEnhancementMode ?? 'standard')
    : (profile.enhancementMode ?? 'standard');
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
      ...(!parsed.enabled && parsed.explicitlyDisabled === true
        ? { explicitlyDisabled: true }
        : {}),
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

export function disableTeachingVoiceSelection(
  language: string,
  profileId: string,
  storage?: StorageLike,
): void {
  const normalized = normalizeProfileId(profileId);
  if (!normalized) return;
  persistTeachingVoiceSelection(
    language,
    { enabled: false, profileId: normalized, explicitlyDisabled: true },
    storage,
  );
}

export function isTeachingVoiceExplicitlyDisabled(
  selection: TeachingVoiceSelection | undefined,
  profileId: string,
): boolean {
  return (
    selection?.enabled === false &&
    (!selection.profileId ||
      (selection.explicitlyDisabled === true &&
        selection.profileId === normalizeProfileId(profileId)))
  );
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
  const fetchReadyProfile = async (profileId?: string): Promise<PublicVoiceProfile | null> => {
    const query = new URLSearchParams({ language });
    if (profileId) query.set('profileId', profileId);
    let response: Response;
    try {
      response = await fetchProfile(`/api/voice-cloning/profile?${query}`);
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as ProfileResponse | null;
    return data?.profile?.status === 'ready' ? data.profile : null;
  };

  const persistedProfile = persisted?.profileId
    ? await fetchReadyProfile(persisted.profileId)
    : null;
  const profile = persistedProfile ?? (await fetchReadyProfile());
  if (!profile) return undefined;
  const profileId = normalizeProfileId(profile.id);
  if (!profileId) return undefined;
  if (isTeachingVoiceExplicitlyDisabled(persisted, profileId)) return undefined;
  activateTeachingVoiceSelection(language, profileId, selectedEnhancementMode(profile), storage);
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
