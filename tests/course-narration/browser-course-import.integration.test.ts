import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  ownerId: 'owner-1',
  authenticated: true,
  bootstrap: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: vi.fn(async () =>
    mocks.authenticated
      ? { id: mocks.ownerId }
      : Response.json({ success: false, error: 'Authentication required' }, { status: 401 }),
  ),
}));
vi.mock('@/lib/config/feature-flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config/feature-flags')>();
  return {
    ...original,
    isCourseNarrationServerEnabled: () => true,
    isServerPersistenceConfigured: () => false,
  };
});
vi.mock('@/lib/server/course-narration', () => ({
  getCourseNarrationBootstrap: mocks.bootstrap,
  synthesizeCourseNarration: mocks.synthesize,
}));

import { GET, PATCH, POST, PUT } from '@/app/api/course-narration/route';
import {
  claimBrowserCourseNarrationRegistration,
  readBrowserCourseNarrationRegistration,
  readCourseNarrationSnapshot,
} from '@/lib/server/course-narration-snapshot';

let storageRoot: string;

function id(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function browserCourse(stageId: string) {
  return {
    stageId,
    stage: {
      id: stageId,
      name: 'Existing IndexedDB course',
      createdAt: 100,
      updatedAt: 200,
      teacherVoiceProfileId: 'profile-qwen',
      lessonLanguage: 'en',
    },
    scenes: [
      {
        id: 'scene-1',
        speech: [
          {
            id: 'speech-1',
            text: '  Exact existing StageStorage transcript.  ',
            audioId: 'original-browser-audio',
          },
        ],
      },
    ],
  };
}

function request(method: 'PATCH' | 'POST' | 'PUT', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/course-narration', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('browser-only StageStorage course import', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'sahaya-course-narration-'));
    process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR = storageRoot;
  });

  afterAll(async () => {
    delete process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR;
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.ownerId = 'owner-1';
    mocks.authenticated = true;
    mocks.bootstrap.mockReset().mockResolvedValue({
      providers: [],
      languages: [],
      bodhanVoices: [],
      bodhanStyles: [],
      savedPreviews: [],
      profile: { id: 'profile-qwen', activeEngine: 'qwen3-tts' },
    });
    mocks.synthesize.mockReset().mockResolvedValue({
      providerId: 'bodhan',
      audio: { format: 'wav', base64: 'AA==' },
    });
  });

  it('claims a real browser-only stage, reloads it, and previews its exact transcript', async () => {
    const stageId = id('browser-stage');
    const payload = browserCourse(stageId);

    const before = await PUT(request('PUT', payload));
    expect(before.status).toBe(409);
    await expect(before.json()).resolves.toMatchObject({
      errorCode: 'COURSE_REGISTRATION_REQUIRED',
    });

    const imported = await PATCH(request('PATCH', payload));
    expect(imported.status).toBe(200);
    await expect(imported.json()).resolves.toMatchObject({
      registered: true,
      created: true,
      source: 'browser-registration',
    });

    const registration = await readBrowserCourseNarrationRegistration(stageId);
    const snapshot = await readCourseNarrationSnapshot('owner-1', stageId);
    expect(registration).toMatchObject({
      ownerId: 'owner-1',
      stageId,
      scenes: payload.scenes,
    });
    expect(snapshot?.scenes).toEqual(payload.scenes);

    const loaded = await GET(
      new NextRequest(`http://localhost/api/course-narration?stageId=${stageId}`),
    );
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toMatchObject({
      source: 'browser-registration',
      narration: { profile: { activeEngine: 'qwen3-tts' } },
    });

    const preview = await POST(
      request('POST', {
        stageId,
        sceneId: 'scene-1',
        actionId: 'speech-1',
        profileId: 'profile-qwen',
        providerId: 'bodhan',
        language: 'en',
        voice: 'Prastuti',
        text: '  Exact existing StageStorage transcript.  ',
      }),
    );
    expect(preview.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        stageId,
        text: '  Exact existing StageStorage transcript.  ',
      }),
    );
    expect(payload.scenes[0].speech[0].audioId).toBe('original-browser-audio');
  });

  it('rejects a second account claiming or synchronizing the same stage id', async () => {
    const stageId = id('collision-stage');
    const payload = browserCourse(stageId);
    expect((await PATCH(request('PATCH', payload))).status).toBe(200);

    mocks.ownerId = 'owner-2';
    expect((await PATCH(request('PATCH', payload))).status).toBe(404);
    expect((await PUT(request('PUT', payload))).status).toBe(404);
    expect((await readBrowserCourseNarrationRegistration(stageId))?.ownerId).toBe('owner-1');
    expect(await readCourseNarrationSnapshot('owner-2', stageId)).toBeNull();
  });

  it('publishes only one owner when two first claims race for the same id', async () => {
    const stageId = id('racing-stage');
    const base = {
      schemaVersion: 1 as const,
      stageId,
      stage: { name: 'Racing course', createdAt: 1, updatedAt: 1 },
      scenes: [{ id: 'scene-1', speech: [{ id: 'speech-1', text: 'Exact text' }] }],
      claimedAt: '2026-01-01T00:00:00.000Z',
    };

    const results = await Promise.all([
      claimBrowserCourseNarrationRegistration({ ...base, ownerId: 'owner-race-a' }),
      claimBrowserCourseNarrationRegistration({ ...base, ownerId: 'owner-race-b' }),
    ]);

    expect(results.sort()).toEqual(['conflict', 'created']);
    expect(['owner-race-a', 'owner-race-b']).toContain(
      (await readBrowserCourseNarrationRegistration(stageId))?.ownerId,
    );
  });

  it('rejects unauthenticated and malformed import payloads without creating a claim', async () => {
    const unauthenticatedId = id('unauthenticated-stage');
    mocks.authenticated = false;
    expect((await PATCH(request('PATCH', browserCourse(unauthenticatedId)))).status).toBe(401);
    expect(await readBrowserCourseNarrationRegistration(unauthenticatedId)).toBeNull();

    mocks.authenticated = true;
    const malformedId = id('malformed-stage');
    const malformed = browserCourse(malformedId);
    malformed.scenes[0].speech[0].text = 'x'.repeat(10_001);
    expect((await PATCH(request('PATCH', malformed))).status).toBe(400);
    expect(await readBrowserCourseNarrationRegistration(malformedId)).toBeNull();

    const oversizedId = id('oversized-stage');
    const oversized = new NextRequest('http://localhost/api/course-narration', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(2 * 1024 * 1024 + 1),
      },
      body: JSON.stringify(browserCourse(oversizedId)),
    });
    expect((await PATCH(oversized)).status).toBe(413);
    expect(await readBrowserCourseNarrationRegistration(oversizedId)).toBeNull();
  });
});
