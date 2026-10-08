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
