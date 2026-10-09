import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  buildCompleteScene: vi.fn(),
  requireSessionUser: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@openmaic/generation', () => ({
  applyOutlineFallbacks: (outline: unknown) => outline,
  buildCompleteScene: mocks.buildCompleteScene,
  buildVisionUserContent: (prompt: string) => prompt,
  generateSceneActions: mocks.generateSceneActions,
  generateSceneContent: mocks.generateSceneContent,
  partitionImagesForVision: () => ({ withSrc: [], withoutSrc: [] }),
}));

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: mocks.requireSessionUser,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: vi.fn() }));
vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/pbl/v2/agents/planner', () => ({ generatePBLV2Project: vi.fn() }));

const outline = {
  id: 'outline-1',
  type: 'slide' as const,
  title: 'Scene 1',
  description: 'First scene',
  keyPoints: ['One'],
  order: 1,
};

function contentBody(attemptId: string, stageId = 'stage-1') {
  return {
    attemptId,
    outline,
    allOutlines: [outline],
    stageInfo: { name: 'Ownership lesson' },
    stageId,
  };
}

function request(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe('authoritative scene generation attempts', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.generateSceneContent.mockReset();
    mocks.generateSceneActions.mockReset();
    mocks.buildCompleteScene.mockReset();
    mocks.requireSessionUser.mockReset().mockResolvedValue({ id: 'owner-1' });
    mocks.resolveModelFromRequest.mockReset().mockResolvedValue({
      model: { provider: 'test', modelId: 'test' },
      modelInfo: { capabilities: {}, outputWindow: 4096 },
      modelString: 'test:test',
      thinkingConfig: undefined,
    });
  });

  test('deduplicates concurrent content and actions under one authoritative attempt', async () => {
    mocks.generateSceneContent.mockResolvedValue({ elements: [] });
    mocks.generateSceneActions.mockResolvedValue([{ id: 'speech-1', type: 'speech', text: 'Hi' }]);
    mocks.buildCompleteScene.mockReturnValue({
      id: 'scene-authoritative',
      stageId: 'stage-1',
      title: outline.title,
      order: 1,
      type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [],
    });

    const { POST: contentPost } = await import('@/app/api/generate/scene-content/route');
    const [firstResponse, secondResponse] = await Promise.all([
      contentPost(request(contentBody('client-attempt-a'))),
      contentPost(request(contentBody('client-attempt-b'))),
    ]);
    const first = await firstResponse.json();
    const second = await secondResponse.json();

    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(first.attemptId).toEqual(expect.any(String));
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.generationVersion).toBe(first.generationVersion);

    const actionsBody = {
      attemptId: first.attemptId,
      generationVersion: first.generationVersion,
      outline,
      allOutlines: [outline],
      content: first.content,
      stageId: 'stage-1',
      previousSpeeches: [],
    };
    const { POST: actionsPost } = await import('@/app/api/generate/scene-actions/route');
    const [firstActionsResponse, secondActionsResponse] = await Promise.all([
      actionsPost(request(actionsBody)),
      actionsPost(request(actionsBody)),
    ]);
    const firstActions = await firstActionsResponse.json();
    const secondActions = await secondActionsResponse.json();

    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
    expect(mocks.buildCompleteScene).toHaveBeenCalledTimes(1);
    expect(secondActions.scene).toEqual(firstActions.scene);
    expect(firstActions.attemptId).toBe(first.attemptId);

    const { POST: commitPost } = await import('@/app/api/generate/scene-attempt/commit/route');
    const firstCommit = await commitPost(
      request({
        attemptId: first.attemptId,
        generationVersion: first.generationVersion,
        stageId: 'stage-1',
        outlineId: outline.id,
        sceneId: firstActions.scene.id,
      }),
    );
    const secondCommit = await commitPost(
      request({
        attemptId: first.attemptId,
        generationVersion: first.generationVersion,
        stageId: 'stage-1',
        outlineId: outline.id,
        sceneId: firstActions.scene.id,
      }),
    );
    expect(await firstCommit.json()).toMatchObject({ accepted: true, alreadyCommitted: false });
    expect(await secondCommit.json()).toMatchObject({ accepted: true, alreadyCommitted: true });

    const reopenedResponse = await contentPost(request(contentBody('client-attempt-reopen')));
    const reopened = await reopenedResponse.json();
    expect(reopened.attemptId).toBe(first.attemptId);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);

    const registry = await import('@/lib/server/scene-generation-attempts');
    registry.cleanupSceneGenerationAttempts(Date.now() + 31 * 60 * 1000);
    expect(registry.sceneGenerationAttemptSnapshotForTests(first.attemptId)).toBeNull();
  });

  test('rejects stale content and actions after an expired owner is superseded', async () => {
    const registry = await import('@/lib/server/scene-generation-attempts');
    registry.clearSceneGenerationAttemptsForTests();
    const generationVersion = registry.createSceneGenerationVersion({
      outline,
      allOutlines: [outline],
    });
    const first = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-1',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'attempt-old',
    }).identity;
    const oldContentGate = Promise.withResolvers<void>();
    const oldContent = registry.runSceneAttemptContent('owner-1', first, async () => {
      await oldContentGate.promise;
      return { content: { elements: ['old'] }, effectiveOutline: outline };
    });

    registry.cleanupSceneGenerationAttempts(Date.now() + 21 * 60 * 1000);
    const second = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-1',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'attempt-new',
    }).identity;
    oldContentGate.resolve();
    await expect(oldContent).rejects.toMatchObject({ code: 'GENERATION_ATTEMPT_STALE' });

    const authoritativeContent = { elements: ['new'] };
    await registry.runSceneAttemptContent('owner-1', second, async () => ({
      content: authoritativeContent,
      effectiveOutline: outline,
    }));
    const oldActionsGate = Promise.withResolvers<void>();
    const oldActions = registry.runSceneAttemptActions(
      'owner-1',
      second,
      authoritativeContent,
      async () => {
        await oldActionsGate.promise;
        return {
          scene: {
            id: 'scene-old-actions',
            stageId: 'stage-1',
            title: outline.title,
            order: 1,
            type: 'slide',
            content: { type: 'slide', elements: [] },
            actions: [],
          } as never,
          previousSpeeches: [],
        };
      },
    );
    registry.cleanupSceneGenerationAttempts(Date.now() + 21 * 60 * 1000);
    const third = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-1',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'attempt-latest',
    }).identity;
    oldActionsGate.resolve();
    await expect(oldActions).rejects.toMatchObject({ code: 'GENERATION_ATTEMPT_STALE' });
    expect(third.attemptId).not.toBe(second.attemptId);
  });

  test('creates a new attempt after terminal failure without colliding across owners', async () => {
    const registry = await import('@/lib/server/scene-generation-attempts');
    registry.clearSceneGenerationAttemptsForTests();
    const generationVersion = registry.createSceneGenerationVersion({
      outline,
      allOutlines: [outline],
    });
    const failed = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-1',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'shared-attempt-id',
    }).identity;
    await expect(
      registry.runSceneAttemptContent('owner-1', failed, async () => {
        throw new Error('terminal provider failure');
      }),
    ).rejects.toThrow('terminal provider failure');

    const retry = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-1',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'retry-attempt-id',
    }).identity;
    const otherOwner = registry.admitSceneGenerationAttempt({
      ownerUserId: 'owner-2',
      stageId: 'stage-1',
      outlineId: outline.id,
      generationVersion,
      proposedAttemptId: 'retry-attempt-id',
    }).identity;

    expect(retry.attemptId).not.toBe(failed.attemptId);
    expect(otherOwner.attemptId).not.toBe(retry.attemptId);
    registry.cleanupSceneGenerationAttempts(Date.now() + 31 * 60 * 1000);
    expect(registry.sceneGenerationAttemptSnapshotForTests(failed.attemptId)).toBeNull();
  });

  test('does not globally serialize different stages', async () => {
    mocks.generateSceneContent.mockResolvedValue({ elements: [] });
    const { POST } = await import('@/app/api/generate/scene-content/route');

    await Promise.all([
      POST(request(contentBody('attempt-stage-1', 'stage-1'))),
      POST(request(contentBody('attempt-stage-2', 'stage-2'))),
    ]);

    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
  });
});
