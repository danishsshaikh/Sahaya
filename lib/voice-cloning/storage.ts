import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { getVoiceCloningStorageDir } from '@/lib/voice-cloning/config';
import type { IncomingVoiceClip } from '@/lib/voice-cloning/audio-validation';
import type { OriginalVoiceRecording, VoiceProfile } from '@/lib/voice-cloning/types';
import { resolveVoiceProfileReferenceLanguage } from '@/lib/voice-cloning/language';

const PROFILE_FILE = 'profile.json';
const REFERENCE_FILE = 'reference.wav';
const ORIGINAL_RECORDING_BASENAME = 'original-recording';
const ACTIVE_PROFILES_FILE = 'active-profiles.json';

interface ActiveVoiceProfiles {
  version: 1;
  activeProfileId?: string;
  byLanguage: Record<string, { profileId: string; selectedAt: string }>;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function safeProfileId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Invalid voice profile id');
  }
  return id;
}

function safeOwnerId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Invalid voice profile owner id');
  }
  return id;
}

export function createVoiceProfileId(): string {
  return `vcp_${nanoid(16)}`;
}

export function getVoiceProfileDir(profileId: string, ownerId: string): string {
  return path.join(
    getVoiceCloningStorageDir(),
    'users',
    safeOwnerId(ownerId),
    'voice-profiles',
    safeProfileId(profileId),
  );
}

function profilePath(profileId: string, ownerId: string): string {
  return path.join(getVoiceProfileDir(profileId, ownerId), PROFILE_FILE);
}

function ownerVoiceProfilesDir(ownerId: string): string {
  return path.join(getVoiceCloningStorageDir(), 'users', safeOwnerId(ownerId), 'voice-profiles');
}

function activeProfilesPath(ownerId: string): string {
  return path.join(ownerVoiceProfilesDir(ownerId), ACTIVE_PROFILES_FILE);
}

export function referenceAudioKeyForProfile(profileId: string, ownerId: string): string {
  return path.resolve(getVoiceProfileDir(profileId, ownerId), REFERENCE_FILE);
}

export function resolveReferenceAudioPath(referenceAudioKey: string): string {
  if (!referenceAudioKey?.trim()) throw new Error('Reference audio key is required');
  return path.resolve(referenceAudioKey);
}

export async function writeVoiceProfile(profile: VoiceProfile): Promise<void> {
  const dir = getVoiceProfileDir(profile.id, profile.ownerId);
  await ensureDir(dir);
  const tmp = path.join(dir, `${PROFILE_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, profilePath(profile.id, profile.ownerId));
}

export async function readVoiceProfile(
  profileId: string,
  ownerId: string,
): Promise<VoiceProfile | null> {
  try {
    const raw = await fs.readFile(profilePath(profileId, ownerId), 'utf8');
    return JSON.parse(raw) as VoiceProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function referenceAudioExists(
  referenceAudioKey: string | undefined,
): Promise<boolean> {
  if (!referenceAudioKey) return false;
  try {
    const stat = await fs.stat(referenceAudioKey);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readActiveVoiceProfiles(ownerId: string): Promise<ActiveVoiceProfiles> {
  try {
    const raw = JSON.parse(
      await fs.readFile(activeProfilesPath(ownerId), 'utf8'),
    ) as Partial<ActiveVoiceProfiles>;
    return {
      version: 1,
      activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined,
      byLanguage:
        raw.byLanguage && typeof raw.byLanguage === 'object'
          ? (raw.byLanguage as ActiveVoiceProfiles['byLanguage'])
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, byLanguage: {} };
    throw error;
  }
}

export async function activateVoiceProfile(
  ownerId: string,
  profileId: string,
): Promise<VoiceProfile> {
  const profile = await readVoiceProfile(safeProfileId(profileId), safeOwnerId(ownerId));
  if (!profile || profile.ownerId !== ownerId) throw new Error('Voice profile not found for owner');
  if (profile.status !== 'ready') throw new Error('Voice profile is not ready');
  try {
    await resolveAuthorizedProfileReference({ ownerId, profileId: profile.id });
  } catch {
    throw new Error('Voice profile reference audio is missing or empty');
  }
  const language = resolveVoiceProfileReferenceLanguage(profile);
  if (!language) throw new Error('Voice profile language is unsupported');
  const current = await readActiveVoiceProfiles(ownerId);
  const selectedAt = new Date().toISOString();
  const next: ActiveVoiceProfiles = {
    version: 1,
    activeProfileId: profile.id,
    byLanguage: {
      ...current.byLanguage,
      [language]: { profileId: profile.id, selectedAt },
    },
  };
  const destination = activeProfilesPath(ownerId);
  await ensureDir(path.dirname(destination));
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, destination);
  return profile;
}

export async function resolveAuthorizedProfileReference(input: {
  ownerId: string;
  profileId: string;
  preferOriginalMimeTypes?: readonly string[];
}): Promise<{
  path: string;
  provenance: 'original-upload' | 'processed-reference';
}> {
  const profile = await readVoiceProfile(
    safeProfileId(input.profileId),
    safeOwnerId(input.ownerId),
  );
  if (!profile || profile.ownerId !== input.ownerId || profile.status !== 'ready') {
    throw new Error('Voice profile is not ready or does not belong to this owner');
  }
  const profileDir = getVoiceProfileDir(profile.id, profile.ownerId);
  const allowedOriginalTypes = new Set(
    (input.preferOriginalMimeTypes ?? []).map((value) => value.toLowerCase()),
  );
  const originalMimeType = profile.originalRecording?.mimeType.toLowerCase().split(';', 1)[0];
  const candidates: Array<{
    key: string | undefined;
    provenance: 'original-upload' | 'processed-reference';
  }> = [];
  if (originalMimeType && allowedOriginalTypes.has(originalMimeType)) {
    candidates.push({ key: profile.originalRecording?.key, provenance: 'original-upload' });
  }
  candidates.push(
    { key: profile.referenceAudioKey, provenance: 'processed-reference' },
    {
      key: referenceAudioKeyForProfile(profile.id, profile.ownerId),
      provenance: 'processed-reference',
    },
  );

  const realProfileDir = await fs.realpath(profileDir).catch(() => null);
  if (!realProfileDir) throw new Error('Voice profile storage is unavailable');
  const resolvedProfileDir = path.resolve(profileDir);
  for (const candidate of candidates) {
    if (!candidate.key?.trim()) continue;
    const resolved = path.resolve(candidate.key);
    if (
      resolved === resolvedProfileDir ||
      !resolved.startsWith(`${resolvedProfileDir}${path.sep}`)
    ) {
      continue;
    }
    const realPath = await fs.realpath(resolved).catch(() => null);
    if (!realPath || !realPath.startsWith(`${realProfileDir}${path.sep}`)) continue;
    const stat = await fs.stat(realPath).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) continue;
    try {
      await fs.access(realPath, fsConstants.R_OK);
    } catch {
      continue;
    }
    return { path: realPath, provenance: candidate.provenance };
  }
  throw new Error('Voice profile reference audio is missing, empty, or outside authorized storage');
}

export async function findCurrentVoiceProfile(
  ownerId: string,
  language?: string,
  readyOnly = false,
): Promise<VoiceProfile | null> {
  const root = path.join(
    getVoiceCloningStorageDir(),
    'users',
    safeOwnerId(ownerId),
    'voice-profiles',
  );
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const profiles: VoiceProfile[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('vcp_')) continue;
    const profile = await readVoiceProfile(entry, ownerId).catch(() => null);
    if (
      profile?.ownerId === ownerId &&
      profile.status !== 'deleted' &&
      (!readyOnly || profile.status === 'ready') &&
      (language === undefined || resolveVoiceProfileReferenceLanguage(profile) === language)
    ) {
      profiles.push(profile);
    }
  }
  profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = await readActiveVoiceProfiles(ownerId);
  const activeProfileId = language
    ? active.byLanguage[language]?.profileId
    : active.activeProfileId;
  if (activeProfileId) {
    const selected = profiles.find((profile) => profile.id === activeProfileId);
    if (selected) return selected;
  }
  return profiles[0] ?? null;
}

export async function listVoiceProfiles(
  ownerId: string,
  options: { language?: string; readyOnly?: boolean } = {},
): Promise<VoiceProfile[]> {
  const root = path.join(
    getVoiceCloningStorageDir(),
    'users',
    safeOwnerId(ownerId),
    'voice-profiles',
  );
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.startsWith('vcp_'))
      .map((entry) => readVoiceProfile(entry, ownerId).catch(() => null)),
  );
  return profiles
    .filter((profile): profile is VoiceProfile => {
      if (!profile || profile.ownerId !== ownerId || profile.status === 'deleted') return false;
      if (options.readyOnly && profile.status !== 'ready') return false;
      return (
        options.language === undefined ||
        resolveVoiceProfileReferenceLanguage(profile) === options.language
      );
    })
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
}

export async function findVoiceProfileByEnrollmentAttempt(
  ownerId: string,
  attemptId: string,
): Promise<VoiceProfile | null> {
  const root = path.join(
    getVoiceCloningStorageDir(),
    'users',
    safeOwnerId(ownerId),
    'voice-profiles',
  );
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith('vcp_')) continue;
    const profile = await readVoiceProfile(entry, ownerId).catch(() => null);
    if (
      profile?.ownerId === ownerId &&
      profile.status !== 'deleted' &&
      profile.enrollmentAttemptId === attemptId
    ) {
      return profile;
    }
  }
  return null;
}

export async function writeReferenceAudio(
  profileId: string,
  ownerId: string,
  bytes: Uint8Array,
): Promise<string> {
  const key = referenceAudioKeyForProfile(profileId, ownerId);
  await ensureDir(path.dirname(key));
  await fs.writeFile(key, bytes, { mode: 0o600 });
  return key;
}

function originalRecordingExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('mp4')) return 'm4a';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('flac')) return 'flac';
  return 'wav';
}

export async function writeOriginalRecording(
  profileId: string,
  ownerId: string,
  recording: IncomingVoiceClip,
): Promise<OriginalVoiceRecording> {
  const dir = getVoiceProfileDir(profileId, ownerId);
  await ensureDir(dir);
  const key = path.join(
    dir,
    `${ORIGINAL_RECORDING_BASENAME}.${originalRecordingExtension(recording.mimeType)}`,
  );
  await fs.writeFile(key, recording.bytes, { mode: 0o600 });
  return {
    key,
    mimeType: recording.mimeType,
    byteLength: recording.bytes.byteLength,
    createdAt: new Date().toISOString(),
  };
}

export async function deleteVoiceProfileAssets(profile: VoiceProfile): Promise<void> {
  if (profile.referenceAudioKey) {
    await fs.rm(profile.referenceAudioKey, { force: true }).catch(() => undefined);
  }
  if (profile.originalRecording?.key) {
    await fs.rm(profile.originalRecording.key, { force: true }).catch(() => undefined);
  }
}
