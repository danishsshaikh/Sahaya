import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: vi.fn(async () => ({ id: 'owner-1' })),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isCourseNarrationServerEnabled: () => true,
  isServerPersistenceConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(async () => ({ loadDocument: mocks.loadDocument })),
}));
vi.mock('@/lib/server/course-narration', () => ({
  getCourseNarrationBootstrap: vi.fn(async () => ({ providers: [] })),
  synthesizeCourseNarration: mocks.synthesize,
}));

import { POST } from '@/app/api/course-narration/route';

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/course-narration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const document = {
  stage: { id: 'course-1', name: 'Course', createdAt: 1, updatedAt: 1 },
  scenes: [
    {
      id: 'scene-1',
      stageId: 'course-1',
      title: 'Scene',
      order: 1,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
      actions: [{ id: 'speech-1', type: 'speech', text: '  Exact persisted text.  ' }],
    },
  ],
};

describe('course narration API ownership and transcript boundary', () => {
  beforeEach(() => {
    mocks.loadDocument.mockReset();
    mocks.synthesize.mockReset();
    mocks.loadDocument.mockResolvedValue(document);
    mocks.synthesize.mockResolvedValue({
      providerId: 'bodhan',
      audio: { format: 'wav', base64: 'AA==' },
    });
  });

  it('passes the exact stored speech text to the provider adapter', async () => {
    const response = await POST(
      request({
        stageId: 'course-1',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        providerId: 'bodhan',
        language: 'en',
        voice: 'Prastuti',
        text: '  Exact persisted text.  ',
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: '  Exact persisted text.  ', ownerId: 'owner-1' }),
    );
  });

  it('rejects stale or rewritten text without calling a provider', async () => {
    const response = await POST(
      request({
        stageId: 'course-1',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        providerId: 'bodhan',
        language: 'en',
        voice: 'Prastuti',
        text: 'Exact persisted text.',
      }) as never,
    );
    expect(response.status).toBe(409);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('does not reveal or synthesize a course outside the owner-scoped store', async () => {
    mocks.loadDocument.mockResolvedValue(null);
    const response = await POST(
      request({
        stageId: 'foreign-course',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        providerId: 'bodhan',
        language: 'en',
        text: '  Exact persisted text.  ',
      }) as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
