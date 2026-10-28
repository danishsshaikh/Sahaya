import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isCourseNarrationServerEnabled } from '@/lib/config/feature-flags';
import { ExternalVoiceProviderError } from '@/lib/server/voice-comparison-http';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';
import {
  isVoiceComparisonLanguageCode,
  isVoiceComparisonProviderId,
} from '@/lib/voice-comparison/catalog';
import { resolveOwnedCourseNarrationSource } from '@/lib/server/course-narration-course';
import {
  readCourseNarrationSnapshot,
  writeCourseNarrationSnapshot,
  type CourseNarrationSceneSnapshot,
} from '@/lib/server/course-narration-snapshot';
import {
  getCourseNarrationBootstrap,
  synthesizeCourseNarration,
} from '@/lib/server/course-narration';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

export const runtime = 'nodejs';
export const maxDuration = 300;

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Course narration switching is disabled');
}

function routeError(error: unknown) {
  if (error instanceof ExternalVoiceProviderError) {
    return apiError(error.code, error.status, error.message, error.metadata.safeDetail);
  }
  if (error instanceof TeachingVoiceError) {
    return apiError('INVALID_REQUEST', error.status, error.message);
  }
  return apiError('INTERNAL_ERROR', 500, 'Course narration could not be generated.');
}

function sourceSpeech(
  sourceScenes: readonly Scene[],
  snapshots: CourseNarrationSceneSnapshot[] | undefined,
  sceneId: string,
): CourseNarrationSceneSnapshot['speech'] | undefined {
  const snapshot = snapshots?.find((candidate) => candidate.id === sceneId);
  if (snapshot) return snapshot.speech;
  const scene = sourceScenes.find((candidate) => candidate.id === sceneId);
  return scene?.actions
    ?.filter((action): action is SpeechAction => action.type === 'speech')
    .map((action) => ({
      id: action.id,
      text: action.text,
      ...(action.audioId ? { audioId: action.audioId } : {}),
    }));
}

function parseSnapshotScenes(
  value: unknown,
  sourceSceneIds: ReadonlySet<string>,
): CourseNarrationSceneSnapshot[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const seenScenes = new Set<string>();
  const result: CourseNarrationSceneSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as { id?: unknown; speech?: unknown };
    if (
      typeof record.id !== 'string' ||
      !sourceSceneIds.has(record.id) ||
      seenScenes.has(record.id) ||
      !Array.isArray(record.speech) ||
      record.speech.length > 1000
    ) {
      return null;
    }
    seenScenes.add(record.id);
    const seenActions = new Set<string>();
    const speech = [] as CourseNarrationSceneSnapshot['speech'];
    for (const action of record.speech) {
      if (!action || typeof action !== 'object') return null;
      const candidate = action as { id?: unknown; text?: unknown; audioId?: unknown };
      if (
        typeof candidate.id !== 'string' ||
        candidate.id.length === 0 ||
        seenActions.has(candidate.id) ||
        typeof candidate.text !== 'string' ||
        candidate.text.length > 10_000 ||
        (candidate.audioId !== undefined && typeof candidate.audioId !== 'string')
      ) {
        return null;
      }
      seenActions.add(candidate.id);
      speech.push({
        id: candidate.id,
        text: candidate.text,
        ...(candidate.audioId ? { audioId: candidate.audioId } : {}),
      });
    }
    result.push({ id: record.id, speech });
  }
  return result;
}

export async function GET(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const stageId = req.nextUrl.searchParams.get('stageId')?.trim();
  const profileId = req.nextUrl.searchParams.get('profileId')?.trim() || undefined;
  if (!stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  try {
    const source = await resolveOwnedCourseNarrationSource(user.id, stageId);
    if (!source) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    const snapshot = await readCourseNarrationSnapshot(user.id, stageId);
    const selectedProfileId = snapshot?.teacherVoiceProfileId ?? source.stage.teacherVoiceProfileId;
    if (profileId && profileId !== selectedProfileId) {
      return apiError(
        'INVALID_REQUEST',
        409,
        'The course Teaching Voice changed. Reload the course.',
      );
    }
    return apiSuccess({
      narration: await getCourseNarrationBootstrap({
        ownerId: user.id,
        stageId,
        profileId: selectedProfileId,
      }),
      source: source.source,
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.stageId !== 'string') {
      return apiError('INVALID_REQUEST', 400, 'Invalid course narration snapshot');
    }
    const source = await resolveOwnedCourseNarrationSource(user.id, body.stageId);
    if (!source) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    const scenes = parseSnapshotScenes(
      body.scenes,
      new Set(source.scenes.map((scene) => scene.id)),
    );
    if (!scenes) return apiError('INVALID_REQUEST', 400, 'Invalid course narration snapshot');
    const teacherVoiceProfileId =
      typeof body.teacherVoiceProfileId === 'string' && body.teacherVoiceProfileId.trim()
        ? body.teacherVoiceProfileId.trim()
        : undefined;
    const lessonLanguage = isVoiceComparisonLanguageCode(body.lessonLanguage)
      ? body.lessonLanguage
      : undefined;
    await writeCourseNarrationSnapshot({
      schemaVersion: 1,
      ownerId: user.id,
      stageId: body.stageId,
      ...(teacherVoiceProfileId ? { teacherVoiceProfileId } : {}),
      ...(lessonLanguage ? { lessonLanguage } : {}),
      scenes,
      updatedAt: new Date().toISOString(),
    });
    return apiSuccess({ synchronized: true, source: source.source });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (
      typeof body.stageId !== 'string' ||
      typeof body.sceneId !== 'string' ||
      typeof body.text !== 'string' ||
      !isVoiceComparisonProviderId(body.providerId) ||
      !isVoiceComparisonLanguageCode(body.language)
    ) {
      return apiError('INVALID_REQUEST', 400, 'Invalid course narration request');
    }
    const source = await resolveOwnedCourseNarrationSource(user.id, body.stageId);
    if (!source) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    const snapshot = await readCourseNarrationSnapshot(user.id, body.stageId);
    const speech = sourceSpeech(source.scenes, snapshot?.scenes, body.sceneId);
    if (!speech) return apiError('INVALID_REQUEST', 404, 'Course scene was not found.');
    const actionId = typeof body.actionId === 'string' ? body.actionId : undefined;
    const expected = actionId
      ? speech.find((action) => action.id === actionId)?.text
      : speech.map((action) => action.text).join('\n');
    if (expected === undefined || expected !== body.text) {
      return apiError(
        'INVALID_REQUEST',
        409,
        'Narration text changed. Reload the course before generating audio.',
      );
    }
    const profileId = snapshot?.teacherVoiceProfileId ?? source.stage.teacherVoiceProfileId;
    if (typeof body.profileId === 'string' && body.profileId !== profileId) {
      return apiError(
        'INVALID_REQUEST',
        409,
        'The course Teaching Voice changed. Reload the course.',
      );
    }
    const preview = await synthesizeCourseNarration({
      ownerId: user.id,
      stageId: body.stageId,
      profileId,
      providerId: body.providerId,
      text: body.text,
      language: body.language,
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      style: typeof body.style === 'string' ? body.style : undefined,
      enhancementMode:
        body.enhancementMode === 'resemble-enhance' ? 'resemble-enhance' : 'standard',
      signal: req.signal,
    });
    return apiSuccess({ preview });
  } catch (error) {
    return routeError(error);
  }
}
