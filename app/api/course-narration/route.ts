import { Buffer } from 'node:buffer';
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
import {
  resolveCourseNarrationAccess,
  resolveOwnedCourseNarrationSource,
} from '@/lib/server/course-narration-course';
import {
  claimBrowserCourseNarrationRegistration,
  readCourseNarrationSnapshot,
  writeCourseNarrationSnapshot,
  type BrowserCourseNarrationRegistration,
  type CourseNarrationSceneSnapshot,
} from '@/lib/server/course-narration-snapshot';
import {
  getCourseNarrationBootstrap,
  resolveCourseNarrationProfile,
  synthesizeCourseNarration,
} from '@/lib/server/course-narration';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_SNAPSHOT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SCENES = 1000;
const MAX_SPEECH_ACTIONS = 5000;
const MAX_TRANSCRIPT_CHARACTERS = 500_000;

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
  snapshots: readonly CourseNarrationSceneSnapshot[] | undefined,
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

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value)
  );
}

function parseSnapshotScenes(value: unknown): CourseNarrationSceneSnapshot[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCENES) return null;
  const seenScenes = new Set<string>();
  const result: CourseNarrationSceneSnapshot[] = [];
  let speechCount = 0;
  let transcriptCharacters = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as { id?: unknown; speech?: unknown };
    if (
      !safeIdentifier(record.id) ||
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
        !safeIdentifier(candidate.id) ||
        seenActions.has(candidate.id) ||
        typeof candidate.text !== 'string' ||
        candidate.text.length > 10_000 ||
        (candidate.audioId !== undefined &&
          (typeof candidate.audioId !== 'string' || candidate.audioId.length > 2048))
      ) {
        return null;
      }
      speechCount += 1;
      transcriptCharacters += candidate.text.length;
      if (speechCount > MAX_SPEECH_ACTIONS || transcriptCharacters > MAX_TRANSCRIPT_CHARACTERS) {
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

async function boundedJson(req: NextRequest): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_BODY_BYTES) {
    throw new TeachingVoiceError('Course narration snapshot is too large.', 413);
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BODY_BYTES) {
    throw new TeachingVoiceError('Course narration snapshot is too large.', 413);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new TeachingVoiceError('Invalid course narration snapshot.');
  }
}

function parseBrowserStage(
  value: unknown,
  stageId: string,
): BrowserCourseNarrationRegistration['stage'] | null {
  if (!value || typeof value !== 'object') return null;
  const stage = value as Record<string, unknown>;
  if (
    stage.id !== stageId ||
    typeof stage.name !== 'string' ||
    stage.name.length === 0 ||
    stage.name.length > 500 ||
    typeof stage.createdAt !== 'number' ||
    !Number.isFinite(stage.createdAt) ||
    typeof stage.updatedAt !== 'number' ||
    !Number.isFinite(stage.updatedAt) ||
    (stage.teacherVoiceProfileId !== undefined &&
      (typeof stage.teacherVoiceProfileId !== 'string' ||
        stage.teacherVoiceProfileId.length > 200)) ||
    (stage.lessonLanguage !== undefined && !isVoiceComparisonLanguageCode(stage.lessonLanguage))
  ) {
    return null;
  }
  return {
    name: stage.name,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
    ...(typeof stage.teacherVoiceProfileId === 'string' && stage.teacherVoiceProfileId
      ? { teacherVoiceProfileId: stage.teacherVoiceProfileId }
      : {}),
    ...(isVoiceComparisonLanguageCode(stage.lessonLanguage)
      ? { lessonLanguage: stage.lessonLanguage }
      : {}),
  };
}

function snapshotFor(input: {
  ownerId: string;
  stageId: string;
  stage: BrowserCourseNarrationRegistration['stage'];
  scenes: CourseNarrationSceneSnapshot[];
  updatedAt: string;
}) {
  return {
    schemaVersion: 1 as const,
    ownerId: input.ownerId,
    stageId: input.stageId,
    ...(input.stage.teacherVoiceProfileId
      ? { teacherVoiceProfileId: input.stage.teacherVoiceProfileId }
      : {}),
    ...(input.stage.lessonLanguage ? { lessonLanguage: input.stage.lessonLanguage } : {}),
    scenes: input.scenes,
    updatedAt: input.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const stageId = req.nextUrl.searchParams.get('stageId')?.trim();
  if (!stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  try {
    const source = await resolveOwnedCourseNarrationSource(user.id, stageId);
    if (!source) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    const snapshot = await readCourseNarrationSnapshot(user.id, stageId);
    const selectedProfileId = snapshot?.teacherVoiceProfileId ?? source.stage.teacherVoiceProfileId;
    const language = snapshot?.lessonLanguage ?? source.stage.lessonLanguage;
    return apiSuccess({
      narration: await getCourseNarrationBootstrap({
        ownerId: user.id,
        stageId,
        profileId: selectedProfileId,
        ...(language ? { language } : {}),
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
    const body = await boundedJson(req);
    if (typeof body.stageId !== 'string') {
      return apiError('INVALID_REQUEST', 400, 'Invalid course narration snapshot');
    }
    const access = await resolveCourseNarrationAccess(user.id, body.stageId);
    if (access.status === 'unregistered') {
      return apiSuccess({ synchronized: false, registrationRequired: true });
    }
    if (access.status === 'forbidden') {
      return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    }
    const source = access.course;
    const scenes = parseSnapshotScenes(body.scenes);
    if (!scenes) return apiError('INVALID_REQUEST', 400, 'Invalid course narration snapshot');
    const requestedProfileId =
      typeof body.teacherVoiceProfileId === 'string' && body.teacherVoiceProfileId.trim()
        ? body.teacherVoiceProfileId.trim()
        : undefined;
    const lessonLanguage = isVoiceComparisonLanguageCode(body.lessonLanguage)
      ? body.lessonLanguage
      : undefined;
    const profile = await resolveCourseNarrationProfile({
      ownerId: user.id,
      profileId: requestedProfileId,
      language: lessonLanguage,
    });
    if (requestedProfileId && !profile) {
      return apiError('INVALID_REQUEST', 404, 'Selected Teaching Voice is not available.');
    }
    await writeCourseNarrationSnapshot({
      schemaVersion: 1,
      ownerId: user.id,
      stageId: body.stageId,
      ...(profile ? { teacherVoiceProfileId: profile.id } : {}),
      ...(lessonLanguage ? { lessonLanguage } : {}),
      scenes,
      updatedAt: new Date().toISOString(),
    });
    return apiSuccess({ synchronized: true, source: source.source });
  } catch (error) {
    return routeError(error);
  }
}

/** Explicitly claim an authenticated browser-only StageStorage course. */
export async function PATCH(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const body = await boundedJson(req);
    if (typeof body.stageId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(body.stageId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid browser course registration');
    }
    const stage = parseBrowserStage(body.stage, body.stageId);
    const scenes = parseSnapshotScenes(body.scenes);
    if (!stage || !scenes || !scenes.some((scene) => scene.speech.length > 0)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid browser course registration');
    }

    const access = await resolveCourseNarrationAccess(user.id, body.stageId);
    if (access.status === 'forbidden') {
      return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    }

    const profile = await resolveCourseNarrationProfile({
      ownerId: user.id,
      profileId: stage.teacherVoiceProfileId,
      language: stage.lessonLanguage,
    });
    const registeredStage = {
      ...stage,
      ...(profile ? { teacherVoiceProfileId: profile.id } : {}),
    };
    if (!profile) delete registeredStage.teacherVoiceProfileId;

    const now = new Date().toISOString();
    let registration: 'created' | 'already-owned' = 'already-owned';
    if (access.status === 'unregistered') {
      const claimed = await claimBrowserCourseNarrationRegistration({
        schemaVersion: 1,
        ownerId: user.id,
        stageId: body.stageId,
        stage: registeredStage,
        scenes,
        claimedAt: now,
      });
      if (claimed === 'conflict') {
        return apiError(
          'COURSE_ID_CONFLICT',
          409,
          'This course ID is already registered to another account.',
        );
      }
      registration = claimed;
    }

    await writeCourseNarrationSnapshot(
      snapshotFor({
        ownerId: user.id,
        stageId: body.stageId,
        stage: registeredStage,
        scenes,
        updatedAt: now,
      }),
    );
    return apiSuccess({
      registered: true,
      created: registration === 'created',
      source: access.status === 'owned' ? access.course.source : ('browser-registration' as const),
    });
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
    const speech = sourceSpeech(
      source.scenes,
      snapshot?.scenes ?? source.registeredScenes,
      body.sceneId,
    );
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
    const profile = await resolveCourseNarrationProfile({
      ownerId: user.id,
      profileId: snapshot?.teacherVoiceProfileId ?? source.stage.teacherVoiceProfileId,
      language: body.language,
    });
    const profileId = profile?.id;
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
