import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  callLLM: vi.fn(),
  resolveVisionImagesForPrompt: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  requireSessionUser: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (callback: () => Promise<void> | void) => {
      mocks.afterCallbacks.push(callback);
    },
  };
});

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: mocks.resolveVisionImagesForPrompt,
}));

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: mocks.requireSessionUser,
}));

const simulationOutline: SceneOutline = {
  id: 'outline-sim',
  type: 'interactive',
  title: 'BST Traversal Simulator',
  description: 'Explore binary search tree traversal.',
  keyPoints: ['Insert nodes', 'Choose traversal', 'Watch the path'],
  order: 1,
  widgetType: 'simulation',
  widgetOutline: { concept: 'bst_traversal', keyVariables: ['traversal'] },
};

describe('scene-content async simulation route', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.afterCallbacks.length = 0;
    mocks.callLLM.mockReset();
    mocks.resolveVisionImagesForPrompt.mockReset();
    mocks.resolveVisionImagesForPrompt.mockResolvedValue([]);
    mocks.resolveModelFromRequest.mockReset();
    mocks.requireSessionUser.mockReset();
    mocks.requireSessionUser.mockResolvedValue({ id: 'owner-a' });
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'gemma' },
      modelInfo: { outputWindow: 8192, capabilities: {} },
      modelString: 'test:gemma',
      thinkingConfig: undefined,
    });

    const { clearSceneContentJobsForTests } = await import('@/lib/server/scene-content-jobs');
    clearSceneContentJobsForTests();
  });

  test('starts simulation generation as a short async job response', async () => {
    const deferred = createDeferred();
    mocks.callLLM.mockImplementation(() =>
      deferred.promise.then(() => ({
        text: simulationHtml(),
      })),
    );

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(sceneContentBody()));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      success: true,
      async: true,
      status: 'queued',
      pollIntervalMs: 3000,
    });
    expect(body.jobId).toEqual(expect.any(String));
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.afterCallbacks).toHaveLength(1);

    const run = mocks.afterCallbacks[0]();
    await Promise.resolve();

    const { GET } = await import('@/app/api/generate/scene-content/status/route');
    const running = await GET(mockStatusRequest(body.jobId));
    expect(await running.json()).toMatchObject({
      success: true,
      jobId: body.jobId,
      status: 'generating',
    });

    deferred.resolve();
    await run;

    const completed = await GET(mockStatusRequest(body.jobId));
    const completedBody = await completed.json();
    expect(completedBody).toMatchObject({
      success: true,
      jobId: body.jobId,
      status: 'completed',
      done: true,
      content: {
        widgetType: 'simulation',
      },
    });
    expect(completedBody.content.html).toContain('BST Traversal Simulator');
  });

  test('reuses equivalent active simulation requests without a second model invocation', async () => {
    const deferred = createDeferred();
    mocks.callLLM.mockImplementation(() =>
      deferred.promise.then(() => ({
        text: simulationHtml(),
      })),
    );

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const first = await POST(mockRequest(sceneContentBody()));
    const firstBody = await first.json();
    const second = await POST(mockRequest(sceneContentBody()));
    const secondBody = await second.json();

    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.status).toBe('queued');
    expect(mocks.afterCallbacks).toHaveLength(1);

    const run = mocks.afterCallbacks[0]();
    await Promise.resolve();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);

    const third = await POST(mockRequest(sceneContentBody()));
    const thirdBody = await third.json();
    expect(thirdBody.jobId).toBe(firstBody.jobId);
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await run;
  });

  test('creates a new job after a genuine failed simulation job', async () => {
    mocks.callLLM
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce({ text: simulationHtml() });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const first = await POST(mockRequest(sceneContentBody()));
    const firstBody = await first.json();
    await mocks.afterCallbacks[0]();

    const second = await POST(mockRequest(sceneContentBody()));
    const secondBody = await second.json();

    expect(secondBody.jobId).not.toBe(firstBody.jobId);
    expect(secondBody.status).toBe('queued');
    expect(mocks.afterCallbacks).toHaveLength(2);
  });

  test('creates a different job for materially different simulation input', async () => {
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const first = await POST(mockRequest(sceneContentBody()));
    const changed = await POST(
      mockRequest(
        sceneContentBody({
          outline: {
            ...simulationOutline,
            keyPoints: ['Changed traversal prompt'],
          },
        }),
      ),
    );

    expect((await changed.json()).jobId).not.toBe((await first.json()).jobId);
  });

  test('threads the requested locale into the async simulation generation prompt', async () => {
    mocks.callLLM.mockResolvedValueOnce({ text: simulationHtml() });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    await POST(
      mockRequest(sceneContentBody(), 'owner-a', {
        'x-user-locale': 'en-US',
      }),
    );
    await mocks.afterCallbacks[0]();

    const request = mocks.callLLM.mock.calls[0][0] as { system?: string; prompt?: string };
    expect(request.system).toContain('The deployment output language is English.');
    expect(request.system).toContain(
      'The upstream requested-language value is: **English (en-US)**',
    );
    expect(request.prompt).toContain('Requested output language: English (en-US)');
    expect(request.prompt).toContain('Teach in English.');
  });

  test('shares one simulation budget across generation and English language repair', async () => {
    mocks.callLLM
      .mockResolvedValueOnce({ text: simulationHtml().replace('<main>', '<main>\u7ee7\u7eed ') })
      .mockResolvedValueOnce({ text: simulationHtml() });
    const beforeRequest = Date.now();
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(sceneContentBody()));
    const { jobId } = await response.json();
    await mocks.afterCallbacks[0]();

    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    const first = mocks.callLLM.mock.calls[0][4].simulationBudget;
    const repair = mocks.callLLM.mock.calls[1][4].simulationBudget;
    expect(first).toBe(repair);
    expect(first.startedAtMs).toBeGreaterThanOrEqual(beforeRequest);
    expect(first.deadlineMs - first.startedAtMs).toBeLessThanOrEqual(290000);
    const { readSceneContentJob } = await import('@/lib/server/scene-content-jobs');
    expect(readSceneContentJob(jobId, 'owner-a')?.status).toBe('completed');
  });

  test('does not apply simulation allocation to other interactive widgets', async () => {
    const diagram = { ...simulationOutline, widgetType: 'diagram' };
    mocks.callLLM.mockResolvedValueOnce({
      text: simulationHtml().replace('"type":"simulation"', '"type":"diagram"'),
    });
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest(sceneContentBody({ outline: diagram, allOutlines: [diagram] })),
    );
    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0][4]).not.toHaveProperty('simulationBudget');
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  test('does not apply simulation allocation to quiz scenes', async () => {
    const quizOutline: SceneOutline = {
      ...simulationOutline,
      id: 'outline-quiz',
      type: 'quiz',
      widgetType: undefined,
      quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['single'] },
    };
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          type: 'single',
          question: 'Which traversal visits the root first?',
          options: ['Preorder', 'Inorder'],
          correctAnswer: 'A',
        },
      ]),
    });
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest(sceneContentBody({ outline: quizOutline, allOutlines: [quizOutline] })),
    );

    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0][4]).not.toHaveProperty('simulationBudget');
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  test("does not expose another user's simulation job status", async () => {
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(sceneContentBody(), 'owner-a'));
    const { jobId } = await response.json();

    const { GET } = await import('@/app/api/generate/scene-content/status/route');
    const forbidden = await GET(mockStatusRequest(jobId, 'owner-b'));
    const body = await forbidden.json();

    expect(forbidden.status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('unknown simulation job ids fail safely', async () => {
    const { GET } = await import('@/app/api/generate/scene-content/status/route');
    const response = await GET(mockStatusRequest('missing-job'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
  });
});

function sceneContentBody(overrides: Record<string, unknown> = {}) {
  return {
    outline: simulationOutline,
    allOutlines: [simulationOutline],
    stageId: 'stage-1',
    stageInfo: { name: 'Trees' },
    languageDirective: 'Teach in English.',
    requirements: { requirement: 'Teach BST traversal', interactiveMode: true },
    ...overrides,
  };
}

function mockRequest(
  body: Record<string, unknown>,
  userId = 'owner-a',
  headers: Record<string, string> = {},
) {
  mocks.requireSessionUser.mockResolvedValueOnce({ id: userId });
  return {
    json: async () => body,
    headers: new Headers(headers),
    nextUrl: new URL('http://localhost/api/generate/scene-content'),
  } as unknown as NextRequest;
}

function mockStatusRequest(jobId: string, userId = 'owner-a') {
  mocks.requireSessionUser.mockResolvedValueOnce({ id: userId });
  return {
    headers: new Headers(),
    nextUrl: new URL(
      `http://localhost/api/generate/scene-content/status?jobId=${encodeURIComponent(jobId)}`,
    ),
  } as unknown as NextRequest;
}

function simulationHtml(): string {
  return `<!DOCTYPE html>
<html>
  <body>
    <script type="application/json" id="widget-config">
      {"type":"simulation","concept":"bst_traversal","description":"BST Traversal Simulator","variables":[]}
    </script>
    <main>BST Traversal Simulator</main>
  </body>
</html>`;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
