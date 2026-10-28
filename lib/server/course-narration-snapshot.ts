import { createHash } from 'node:crypto';
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

function rootDirectory(): string {
  return path.join(process.cwd(), 'data', 'course-narration');
}

function ownerDirectory(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex');
}

function snapshotPath(ownerId: string, stageId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) throw new Error('Invalid narration stage id');
  return path.join(rootDirectory(), ownerDirectory(ownerId), `${stageId}.json`);
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
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}
