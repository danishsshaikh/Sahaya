import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  loadDocument: vi.fn(),
  readClassroom: vi.fn(),
  readRegistration: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => true,
}));
vi.mock('@/lib/server/stage-access', () => ({
  resolveStageAccess: mocks.resolveAccess,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(async () => ({ loadDocument: mocks.loadDocument })),
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  readClassroom: mocks.readClassroom,
}));
vi.mock('@/lib/server/course-narration-snapshot', () => ({
  readBrowserCourseNarrationRegistration: mocks.readRegistration,
}));

import {
  resolveCourseNarrationAccess,
  resolveOwnedCourseNarrationSource,
} from '@/lib/server/course-narration-course';

const stage = { id: 'stage-1', name: 'Existing', createdAt: 1, updatedAt: 1 };
const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Scene',
  order: 1,
  type: 'quiz',
  content: { type: 'quiz', questions: [] },
  actions: [{ id: 'speech-1', type: 'speech', text: 'Existing transcript' }],
};

describe('existing classroom narration source resolution', () => {
  beforeEach(() => {
    mocks.resolveAccess.mockReset().mockResolvedValue(null);
    mocks.loadDocument.mockReset().mockResolvedValue(null);
    mocks.readClassroom.mockReset().mockResolvedValue(null);
    mocks.readRegistration.mockReset().mockResolvedValue(null);
  });

  it('uses the current owner-checked document store when the stage is there', async () => {
    mocks.resolveAccess.mockResolvedValue({ ownerId: 'owner-1' });
    mocks.loadDocument.mockResolvedValue({ stage, scenes: [scene] });

    await expect(resolveOwnedCourseNarrationSource('owner-1', 'stage-1')).resolves.toMatchObject({
      stage,
      scenes: [scene],
      source: 'document',
    });
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });

  it.each(['stage-1', 'stage-2'])(
    'falls back to the authenticated legacy classroom store for %s',
    async (stageId) => {
      mocks.readClassroom.mockResolvedValue({
        id: stageId,
        ownerUserId: 'owner-1',
        stage: { ...stage, id: stageId },
        scenes: [{ ...scene, stageId }],
      });

      await expect(resolveOwnedCourseNarrationSource('owner-1', stageId)).resolves.toMatchObject({
        stage: { id: stageId },
        source: 'legacy-classroom',
      });
    },
  );

  it('does not fall through when a document-stage id belongs to another user', async () => {
    mocks.resolveAccess.mockResolvedValue({ ownerId: 'owner-2' });
    mocks.readClassroom.mockResolvedValue({ ownerUserId: 'owner-1', stage, scenes: [scene] });

    await expect(resolveOwnedCourseNarrationSource('owner-1', 'stage-1')).resolves.toBeNull();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
  });

  it('rejects foreign legacy classrooms and invalid identifiers', async () => {
    mocks.readClassroom.mockResolvedValue({ ownerUserId: 'owner-2', stage, scenes: [scene] });

    await expect(resolveOwnedCourseNarrationSource('owner-1', 'stage-1')).resolves.toBeNull();
    await expect(resolveOwnedCourseNarrationSource('owner-1', '../stage-1')).resolves.toBeNull();
  });

  it('resolves an explicitly claimed browser-only StageStorage course', async () => {
    mocks.readRegistration.mockResolvedValue({
      schemaVersion: 1,
      ownerId: 'owner-1',
      stageId: 'stage-1',
      stage: { name: 'Browser course', createdAt: 1, updatedAt: 2 },
      scenes: [{ id: 'scene-1', speech: [{ id: 'speech-1', text: 'Exact browser transcript' }] }],
      claimedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(resolveOwnedCourseNarrationSource('owner-1', 'stage-1')).resolves.toMatchObject({
      source: 'browser-registration',
      sceneIds: ['scene-1'],
      registeredScenes: [
        { id: 'scene-1', speech: [{ id: 'speech-1', text: 'Exact browser transcript' }] },
      ],
    });
  });

  it('distinguishes unregistered browser stages from foreign claims without exposing either', async () => {
    await expect(resolveCourseNarrationAccess('owner-1', 'stage-1')).resolves.toEqual({
      status: 'unregistered',
    });
    mocks.readRegistration.mockResolvedValue({
      schemaVersion: 1,
      ownerId: 'owner-2',
      stageId: 'stage-1',
      stage: { name: 'Other', createdAt: 1, updatedAt: 1 },
      scenes: [],
      claimedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(resolveCourseNarrationAccess('owner-1', 'stage-1')).resolves.toEqual({
      status: 'forbidden',
    });
  });
});
