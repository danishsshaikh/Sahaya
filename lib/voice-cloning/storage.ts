import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { getVoiceCloningStorageDir } from '@/lib/voice-cloning/config';
import type { VoiceProfile } from '@/lib/voice-cloning/types';
import { resolveVoiceProfileLanguageId } from '@/lib/voice-cloning/types';
import { resolveTeachingVoiceLanguage } from '@/lib/voice-cloning/language';

const PROFILE_FILE = 'profile.json';
const REFERENCE_FILE = 'reference.wav';

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

export function referenceAudioKeyForProfile(profileId: string, ownerId: string): string {
  return path.resolve(getVoiceProfileDir(profileId, ownerId), REFERENCE_FILE);
}

export function resolveReferenceAudioPath(referenceAudioKey: string): string {
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
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
      profile?.ownerId === ownerId && profile.status !== 'deleted' &&
      (!readyOnly || profile.status === 'ready') &&
      (language === undefined ||
        resolveTeachingVoiceLanguage(resolveVoiceProfileLanguageId(profile)) === language)
    ) {
      profiles.push(profile);
    }
  }
  profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return profiles[0] ?? null;
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

export async function deleteVoiceProfileAssets(profile: VoiceProfile): Promise<void> {
  if (profile.referenceAudioKey) {
    await fs.rm(profile.referenceAudioKey, { force: true }).catch(() => undefined);
  }
}
