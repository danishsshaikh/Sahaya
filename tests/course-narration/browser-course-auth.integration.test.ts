import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getAuthUser } from '@/app/api/auth/me/route';
import { PATCH } from '@/app/api/course-narration/route';
import { AUTH_COOKIE_NAME, createSession, createUser } from '@/lib/auth/server';
import { readBrowserCourseNarrationRegistration } from '@/lib/server/course-narration-snapshot';

let dataRoot: string;
let previousAuthRoot: string | undefined;
let previousNarrationRoot: string | undefined;
let previousNarrationFlag: string | undefined;
let previousDatabaseUrl: string | undefined;

function registrationRequest(stageId: string, token?: string) {
  return new NextRequest('http://localhost/api/course-narration', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } : {}),
    },
    body: JSON.stringify({
      stageId,
      stage: {
        id: stageId,
        name: 'Authenticated browser course',
        createdAt: 1,
        updatedAt: 2,
        lessonLanguage: 'en',
      },
      lessonLanguage: 'en',
      scenes: [
        {
          id: 'scene-1',
          speech: [{ id: 'speech-1', text: 'Exact authenticated transcript' }],
        },
      ],
    }),
  });
}

describe('browser course registration with Sahaya authentication', () => {
  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'sahaya-course-auth-'));
    previousAuthRoot = process.env.OPENMAIC_AUTH_DATA_DIR;
    previousNarrationRoot = process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR;
    previousNarrationFlag = process.env.OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.OPENMAIC_AUTH_DATA_DIR = path.join(dataRoot, 'auth');
    process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR = path.join(dataRoot, 'narration');
    process.env.OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING = '1';
    delete process.env.DATABASE_URL;
  });

  afterAll(async () => {
    if (previousAuthRoot === undefined) delete process.env.OPENMAIC_AUTH_DATA_DIR;
    else process.env.OPENMAIC_AUTH_DATA_DIR = previousAuthRoot;
    if (previousNarrationRoot === undefined) delete process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR;
    else process.env.OPENMAIC_COURSE_NARRATION_DATA_DIR = previousNarrationRoot;
    if (previousNarrationFlag === undefined)
      delete process.env.OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING;
    else process.env.OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING = previousNarrationFlag;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('binds a browser course to the signed-in account and rejects a different account', async () => {
    const stageId = `auth-stage-${randomUUID()}`;
    const owner = await createUser({
      name: 'Owner Faculty',
      email: 'owner@mituniversity.edu.in',
      password: 'owner-pass-123',
    });
    const other = await createUser({
      name: 'Other Faculty',
      email: 'other@mituniversity.edu.in',
      password: 'other-pass-123',
    });
    const ownerSession = await createSession(owner.id);
    const otherSession = await createSession(other.id);

    expect((await PATCH(registrationRequest(stageId))).status).toBe(401);

    const authResponse = await getAuthUser(
      new NextRequest('http://localhost/api/auth/me', {
        headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(ownerSession.token)}` },
      }),
    );
    expect(authResponse.status).toBe(200);
    await expect(authResponse.json()).resolves.toMatchObject({
      success: true,
      user: { id: owner.id },
    });

    expect((await PATCH(registrationRequest(stageId, ownerSession.token))).status).toBe(200);
    expect((await PATCH(registrationRequest(stageId, otherSession.token))).status).toBe(404);
    expect((await readBrowserCourseNarrationRegistration(stageId))?.ownerId).toBe(owner.id);
  });
});
