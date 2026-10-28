import type { AppDocument } from '@/lib/document-store';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { readClassroom } from '@/lib/server/classroom-storage';
import {
  readBrowserCourseNarrationRegistration,
  type CourseNarrationSceneSnapshot,
} from '@/lib/server/course-narration-snapshot';
import { resolveStageAccess } from '@/lib/server/stage-access';
import type { Scene, Stage } from '@/lib/types/stage';

export interface OwnedCourseNarrationSource {
  stage: Pick<Stage, 'id' | 'teacherVoiceProfileId'>;
  scenes: Scene[];
  registeredScenes?: CourseNarrationSceneSnapshot[];
  sceneIds: string[];
  source: 'document' | 'legacy-classroom' | 'browser-registration';
}

export type CourseNarrationAccess =
  | { status: 'owned'; course: OwnedCourseNarrationSource }
  | { status: 'unregistered' }
  | { status: 'forbidden' };

/**
 * Resolve the same stage identity used by `/classroom/[id]`, while requiring
 * mutation ownership. Existing classrooms may live in the current document
 * store, the authenticated legacy classroom store, or an explicit browser
 * course registration bound to the authenticated account.
 */
export async function resolveCourseNarrationAccess(
  ownerId: string,
  stageId: string,
): Promise<CourseNarrationAccess> {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) return { status: 'forbidden' };

  if (isServerPersistenceConfigured()) {
    const access = await resolveStageAccess(stageId);
    if (access) {
      if (access.ownerId !== ownerId) return { status: 'forbidden' };
      const store = await getOwnerScopedDocumentStore(ownerId);
      const document = (await store.loadDocument(stageId)) as AppDocument | null;
      if (!document) return { status: 'forbidden' };
      return {
        status: 'owned',
        course: {
          stage: document.stage as Stage,
          scenes: document.scenes as Scene[],
          sceneIds: document.scenes.map((scene) => scene.id),
          source: 'document',
        },
      };
    }
  }

  const legacy = await readClassroom(stageId);
  if (legacy) {
    if (legacy.ownerUserId !== ownerId) return { status: 'forbidden' };
    return {
      status: 'owned',
      course: {
        stage: legacy.stage,
        scenes: legacy.scenes,
        sceneIds: legacy.scenes.map((scene) => scene.id),
        source: 'legacy-classroom',
      },
    };
  }

  const registration = await readBrowserCourseNarrationRegistration(stageId);
  if (!registration) return { status: 'unregistered' };
  if (registration.ownerId !== ownerId) return { status: 'forbidden' };
  return {
    status: 'owned',
    course: {
      stage: {
        id: stageId,
        ...(registration.stage.teacherVoiceProfileId
          ? { teacherVoiceProfileId: registration.stage.teacherVoiceProfileId }
          : {}),
      },
      scenes: [],
      registeredScenes: registration.scenes,
      sceneIds: registration.scenes.map((scene) => scene.id),
      source: 'browser-registration',
    },
  };
}

export async function resolveOwnedCourseNarrationSource(
  ownerId: string,
  stageId: string,
): Promise<OwnedCourseNarrationSource | null> {
  const access = await resolveCourseNarrationAccess(ownerId, stageId);
  return access.status === 'owned' ? access.course : null;
}
