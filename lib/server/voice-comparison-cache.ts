import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getVoiceCloningStorageDir } from '@/lib/voice-cloning/config';
import type { VoiceComparisonPreviewResult } from '@/lib/voice-comparison/types';

interface StoredVoiceComparisonCache {
  version: 1;
  entries: VoiceComparisonPreviewResult[];
}

const MAX_CACHE_ENTRIES = 24;
const MAX_CACHE_BASE64_CHARACTERS = 32 * 1024 * 1024;
const ownerWrites = new Map<string, Promise<void>>();

function safeOwnerId(ownerId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ownerId)) throw new Error('Invalid voice comparison owner id');
  return ownerId;
}

function cachePath(ownerId: string): string {
  return path.join(
    getVoiceCloningStorageDir(),
    'users',
    safeOwnerId(ownerId),
    'voice-comparisons',
    'cache.json',
  );
}

export function createVoiceComparisonCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readCache(ownerId: string): Promise<StoredVoiceComparisonCache> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(cachePath(ownerId), 'utf8'),
    ) as StoredVoiceComparisonCache;
    return parsed.version === 1 && Array.isArray(parsed.entries)
      ? parsed
      : { version: 1, entries: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
}

export async function readVoiceComparisonCache(
  ownerId: string,
  key: string,
): Promise<VoiceComparisonPreviewResult | null> {
  const cache = await readCache(ownerId);
  const result = cache.entries.find((entry) => entry.cacheKey === key);
  return result ? { ...result, cached: true } : null;
}

export async function readVoiceComparisonCacheEntries(
  ownerId: string,
  profileId: string,
): Promise<VoiceComparisonPreviewResult[]> {
  const cache = await readCache(ownerId);
  return cache.entries
    .filter((entry) => entry.profileId === profileId)
    .map((entry) => ({ ...entry, cached: true }));
}

export async function writeVoiceComparisonCache(
  ownerId: string,
  result: VoiceComparisonPreviewResult,
): Promise<void> {
  const previous = ownerWrites.get(ownerId) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const file = cachePath(ownerId);
      const cache = await readCache(ownerId);
      const entries = [
        result,
        ...cache.entries.filter((entry) => entry.cacheKey !== result.cacheKey),
      ]
        .slice(0, MAX_CACHE_ENTRIES)
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
      while (
        entries.length > 1 &&
        entries.reduce((total, entry) => total + entry.audio.base64.length, 0) >
          MAX_CACHE_BASE64_CHARACTERS
      ) {
        entries.pop();
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    });
  ownerWrites.set(ownerId, write);
  try {
    await write;
  } finally {
    if (ownerWrites.get(ownerId) === write) ownerWrites.delete(ownerId);
  }
}

export function clearVoiceComparisonCacheForTests(): void {
  ownerWrites.clear();
}
