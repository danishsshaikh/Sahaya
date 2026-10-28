import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VoiceComparisonLanguageCode } from '@/lib/voice-comparison/types';

export interface CourseNarrationSpeechSnapshot {
  id: string;
  text: string;
  audioId?: string;
}

export interface CourseNarrationSceneSnapshot {
  id: string;
  speech: CourseNarrationSpeechSnapshot[];
}

export interface CourseNarrationSnapshot {
  schemaVersion: 1;
  ownerId: string;
  stageId: string;
  teacherVoiceProfileId?: string;
  lessonLanguage?: VoiceComparisonLanguageCode;
  scenes: CourseNarrationSceneSnapshot[];
  updatedAt: string;
}

export interface BrowserCourseNarrationRegistration {
  schemaVersion: 1;
  ownerId: string;
  stageId: string;
  stage: {
    name: string;
    createdAt: number;
    updatedAt: number;
    teacherVoiceProfileId?: string;
    lessonLanguage?: VoiceComparisonLanguageCode;
  };
  scenes: CourseNarrationSceneSnapshot[];
  claimedAt: string;
}

function rootDirectory(): string {
  return (
    process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR?.trim() ||
    path.join(process.cwd(), 'data', 'course-narration')
  );
}

function ownerDirectory(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex');
}

function snapshotPath(ownerId: string, stageId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) throw new Error('Invalid narration stage id');
  return path.join(rootDirectory(), ownerDirectory(ownerId), `${stageId}.json`);
}

function registrationPath(stageId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) throw new Error('Invalid narration stage id');
  return path.join(rootDirectory(), 'browser-courses', `${stageId}.json`);
}

export async function readBrowserCourseNarrationRegistration(
  stageId: string,
): Promise<BrowserCourseNarrationRegistration | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(registrationPath(stageId), 'utf8'),
    ) as BrowserCourseNarrationRegistration;
    return parsed.schemaVersion === 1 && parsed.stageId === stageId ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Atomically binds an otherwise server-unknown browser course id to the
 * authenticated account. A hard link publishes only a fully written file and
 * can never replace an existing claim; EEXIST is resolved by reading the
 * winner and comparing its server-derived owner id.
 */
export async function claimBrowserCourseNarrationRegistration(
  registration: BrowserCourseNarrationRegistration,
): Promise<'created' | 'already-owned' | 'conflict'> {
  const file = registrationPath(registration.stageId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(registration), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await fs.link(temporary, file);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readBrowserCourseNarrationRegistration(registration.stageId);
    if (!existing) throw new Error('Existing browser course registration is invalid');
    return existing.ownerId === registration.ownerId ? 'already-owned' : 'conflict';
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function readCourseNarrationSnapshot(
  ownerId: string,
  stageId: string,
): Promise<CourseNarrationSnapshot | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(snapshotPath(ownerId, stageId), 'utf8'),
    ) as CourseNarrationSnapshot;
    return parsed.schemaVersion === 1 && parsed.ownerId === ownerId && parsed.stageId === stageId
      ? parsed
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeCourseNarrationSnapshot(
  snapshot: CourseNarrationSnapshot,
): Promise<void> {
  const file = snapshotPath(snapshot.ownerId, snapshot.stageId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}
