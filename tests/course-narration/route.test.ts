import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveCourse: vi.fn(),
  resolveAccess: vi.fn(),
  claimRegistration: vi.fn(),
  readSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  bootstrap: vi.fn(),
  resolveProfile: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: vi.fn(async () => ({ id: 'owner-1' })),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isCourseNarrationServerEnabled: () => true,
}));
vi.mock('@/lib/server/course-narration-course', () => ({
  resolveOwnedCourseNarrationSource: mocks.resolveCourse,
  resolveCourseNarrationAccess: mocks.resolveAccess,
}));
vi.mock('@/lib/server/course-narration-snapshot', () => ({
  claimBrowserCourseNarrationRegistration: mocks.claimRegistration,
  readCourseNarrationSnapshot: mocks.readSnapshot,
  writeCourseNarrationSnapshot: mocks.writeSnapshot,
}));
vi.mock('@/lib/server/course-narration', () => ({
  getCourseNarrationBootstrap: mocks.bootstrap,
  resolveCourseNarrationProfile: mocks.resolveProfile,
  synthesizeCourseNarration: mocks.synthesize,
}));

import { GET, POST, PUT } from '@/app/api/course-narration/route';

function request(method: 'POST' | 'PUT', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/course-narration', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const course = {
  stage: {
    id: 'course-1',
    name: 'Course',
    createdAt: 1,
    updatedAt: 1,
    teacherVoiceProfileId: 'vcp_qwen',
  },
  scenes: [
    {
      id: 'scene-1',
      stageId: 'course-1',
      title: 'Scene',
      order: 1,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
      actions: [
        {
          id: 'speech-1',
          type: 'speech',
          text: '  Exact persisted text.  ',
          audioId: 'original-audio',
        },
      ],
    },
  ],
  source: 'legacy-classroom' as const,
  sceneIds: ['scene-1'],
};

describe('course narration production route compatibility', () => {
  beforeEach(() => {
    mocks.resolveCourse.mockReset().mockResolvedValue(course);
    mocks.resolveAccess.mockReset().mockResolvedValue({ status: 'owned', course });
    mocks.claimRegistration.mockReset().mockResolvedValue('created');
    mocks.readSnapshot.mockReset().mockResolvedValue(null);
    mocks.writeSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.bootstrap.mockReset().mockResolvedValue({
      providers: [],
      languages: [],
      bodhanVoices: [],
      bodhanStyles: [],
      savedPreviews: [],
      profile: { id: 'vcp_qwen', activeEngine: 'qwen3-tts' },
    });
    mocks.resolveProfile
      .mockReset()
      .mockImplementation(async ({ profileId }: { profileId?: string }) =>
        profileId ? { id: profileId, ownerId: 'owner-1', status: 'ready' } : null,
      );
    mocks.synthesize.mockReset().mockResolvedValue({
      providerId: 'bodhan',
      audio: { format: 'wav', base64: 'AA==' },
    });
  });

  it.each(['course-1', 'course-2'])(
    'loads existing classroom stage %s without narration-version metadata',
    async (stageId) => {
      mocks.resolveCourse.mockResolvedValueOnce({
        ...course,
        stage: { ...course.stage, id: stageId },
        scenes: course.scenes.map((scene) => ({ ...scene, stageId })),
      });
      const response = await GET(
        new NextRequest(`http://localhost/api/course-narration?stageId=${stageId}`),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.source).toBe('legacy-classroom');
      expect(body.narration.profile.activeEngine).toBe('qwen3-tts');
      expect(mocks.bootstrap).toHaveBeenCalledWith({
        ownerId: 'owner-1',
        stageId,
        profileId: 'vcp_qwen',
      });
    },
  );

  it('synchronizes hydrated StageStorage narration without changing persisted course content', async () => {
    const response = await PUT(
      request('PUT', {
        stageId: 'course-1',
        teacherVoiceProfileId: 'vcp_qwen',
        lessonLanguage: 'en',
        scenes: [
          {
            id: 'scene-1',
            speech: [
              {
                id: 'speech-1',
                text: '  Exact client-hydrated text.  ',
                audioId: 'original-audio',
              },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.writeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        stageId: 'course-1',
        teacherVoiceProfileId: 'vcp_qwen',
        scenes: [
          {
            id: 'scene-1',
            speech: [
              {
                id: 'speech-1',
                text: '  Exact client-hydrated text.  ',
                audioId: 'original-audio',
              },
            ],
          },
        ],
      }),
    );
    expect(course.scenes[0].actions[0].text).toBe('  Exact persisted text.  ');
    expect(course.scenes[0].actions[0].audioId).toBe('original-audio');
  });

  it('binds a browser course without a profile pointer to the owner current ready profile', async () => {
    mocks.resolveProfile.mockResolvedValueOnce({
      id: 'vcp_current',
      ownerId: 'owner-1',
      status: 'ready',
    });

    const response = await PUT(
      request('PUT', {
        stageId: 'course-1',
        lessonLanguage: 'en',
        scenes: [{ id: 'scene-1', speech: [{ id: 'speech-1', text: 'Existing text.' }] }],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveProfile).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      profileId: undefined,
      language: 'en',
    });
    expect(mocks.writeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ teacherVoiceProfileId: 'vcp_current' }),
    );
  });

  it('previews the exact synchronized transcript and derives the profile server-side', async () => {
    mocks.readSnapshot.mockResolvedValue({
      schemaVersion: 1,
      ownerId: 'owner-1',
      stageId: 'course-1',
      teacherVoiceProfileId: 'vcp_qwen',
      scenes: [
        {
          id: 'scene-1',
          speech: [{ id: 'speech-1', text: '  Exact client-hydrated text.  ' }],
        },
      ],
    });
    const response = await POST(
      request('POST', {
        stageId: 'course-1',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        profileId: 'vcp_qwen',
        providerId: 'bodhan',
        language: 'en',
        voice: 'Prastuti',
        text: '  Exact client-hydrated text.  ',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '  Exact client-hydrated text.  ',
        ownerId: 'owner-1',
        profileId: 'vcp_qwen',
      }),
    );
  });

  it('rejects stale transcripts without scheduling provider work', async () => {
    const response = await POST(
      request('POST', {
        stageId: 'course-1',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        providerId: 'bodhan',
        language: 'en',
        voice: 'Prastuti',
        text: 'Rewritten text.',
      }),
    );
    expect(response.status).toBe(409);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('rejects unauthorized course IDs without revealing or synchronizing them', async () => {
    mocks.resolveCourse.mockResolvedValue(null);
    mocks.resolveAccess.mockResolvedValue({ status: 'forbidden' });
    const getResponse = await GET(
      new NextRequest('http://localhost/api/course-narration?stageId=foreign-course'),
    );
    const putResponse = await PUT(request('PUT', { stageId: 'foreign-course', scenes: [] }));
    const postResponse = await POST(
      request('POST', {
        stageId: 'foreign-course',
        sceneId: 'scene-1',
        providerId: 'bodhan',
        language: 'en',
        text: 'Private text',
      }),
    );

    expect([getResponse.status, putResponse.status, postResponse.status]).toEqual([404, 404, 404]);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
