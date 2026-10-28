import type { AppDocument } from '@/lib/document-store';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { readClassroom } from '@/lib/server/classroom-storage';
import { resolveStageAccess } from '@/lib/server/stage-access';
import type { Scene, Stage } from '@/lib/types/stage';

export interface OwnedCourseNarrationSource {
  stage: Stage;
  scenes: Scene[];
  source: 'document' | 'legacy-classroom';
}

/**
 * Resolve the same stage identity used by `/classroom/[id]`, while requiring
 * mutation ownership. Existing classrooms may live in either the current
 * document store or the authenticated legacy classroom store.
 */
export async function resolveOwnedCourseNarrationSource(
  ownerId: string,
  stageId: string,
): Promise<OwnedCourseNarrationSource | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(stageId)) return null;

  if (isServerPersistenceConfigured()) {
    const access = await resolveStageAccess(stageId);
    if (access) {
      if (access.ownerId !== ownerId) return null;
      const store = await getOwnerScopedDocumentStore(ownerId);
      const document = (await store.loadDocument(stageId)) as AppDocument | null;
      if (!document) return null;
      return {
        stage: document.stage as Stage,
        scenes: document.scenes as Scene[],
        source: 'document',
      };
    }
  }

  const legacy = await readClassroom(stageId);
  if (!legacy || legacy.ownerUserId !== ownerId) return null;
  return {
    stage: legacy.stage,
    scenes: legacy.scenes,
    source: 'legacy-classroom',
  };
}
