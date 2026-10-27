import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isCourseNarrationServerEnabled,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ExternalVoiceProviderError } from '@/lib/server/voice-comparison-http';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';
import {
  isVoiceComparisonLanguageCode,
  isVoiceComparisonProviderId,
} from '@/lib/voice-comparison/catalog';
import {
  getCourseNarrationBootstrap,
  synthesizeCourseNarration,
} from '@/lib/server/course-narration';
import type { AppDocument } from '@/lib/document-store';
import type { SpeechAction } from '@/lib/types/action';

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

async function ownedDocument(ownerId: string, stageId: string): Promise<AppDocument | null> {
  if (!isServerPersistenceConfigured()) return null;
  const store = await getOwnerScopedDocumentStore(ownerId);
  return (await store.loadDocument(stageId)) as AppDocument | null;
}

export async function GET(req: NextRequest) {
  if (!isCourseNarrationServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const stageId = req.nextUrl.searchParams.get('stageId')?.trim();
  const profileId = req.nextUrl.searchParams.get('profileId')?.trim() || undefined;
  if (!stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  const document = await ownedDocument(user.id, stageId);
  if (!document) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
  try {
    return apiSuccess({
      narration: await getCourseNarrationBootstrap({ ownerId: user.id, stageId, profileId }),
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
    const document = await ownedDocument(user.id, body.stageId);
    if (!document) return apiError('INVALID_REQUEST', 404, 'Course was not found.');
    const scene = document.scenes.find((candidate) => candidate.id === body.sceneId);
    if (!scene) return apiError('INVALID_REQUEST', 404, 'Course scene was not found.');
    const speech = (scene.actions ?? []).filter(
      (action): action is SpeechAction => action.type === 'speech',
    );
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
    const preview = await synthesizeCourseNarration({
      ownerId: user.id,
      stageId: body.stageId,
      profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
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
