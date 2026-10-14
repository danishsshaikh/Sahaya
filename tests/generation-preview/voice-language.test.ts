import { describe, expect, it, vi } from 'vitest';
import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { SceneOutline } from '@/lib/types/generation';
import {
  normalizeGenerationPreviewLanguageState,
  resolveGenerationPreviewLanguage,
  validateGenerationPreviewVoiceSelection,
} from '@/app/generation-preview/voice-language';
import { GenerationTeachingVoiceProfileError } from '@/lib/voice-cloning/selection-client';

function session(
  languageDirective: string,
  lessonLanguage?: GenerationSessionState['lessonLanguage'],
): GenerationSessionState {
  return {
    sessionId: 'generation-session-1',
    requirements: { requirement: 'Generate a short lesson.' },
    pdfText: '',
    sceneOutlines: [
      {
        id: 'outline-1',
        type: 'slide',
        title: 'Force',
        description: 'Explain force.',
        keyPoints: ['Definition'],
        order: 1,
      },
    ],
    currentStep: 'generating',
    previewPhase: 'generating-content',
    teacherVoiceProfileId: 'vcp_selected',
    languageDirective,
    lessonLanguage,
  };
}

function readyProfileResponse(language: 'en' | 'hi' | 'mr'): Response {
  return {
    ok: true,
    json: vi.fn(async () => ({
      profile: {
        id: 'vcp_selected',
        status: 'ready',
        provider: language === 'en' ? 'chatterbox' : 'indicf5',
        language,
      },
    })),
  } as unknown as Response;
}

describe('generation preview Teaching Voice language propagation', () => {
  it('retains Hindi from the exact Force lesson request when the completed SSE directive is generic', async () => {
    const outlines: SceneOutline[] = Array.from({ length: 4 }, (_, index) => ({
      id: `outline-${index + 1}`,
      type: index === 2 ? 'quiz' : 'slide',
      title: `Force ${index + 1}`,
      description: 'Force lesson scene.',
      keyPoints: ['Force'],
      order: index + 1,
    }));
    const doneEvent = {
      type: 'done',
      outlines,
      languageDirective: 'Teach in the language that matches the user requirement.',
    };
    const previewSession = normalizeGenerationPreviewLanguageState(
      {
        ...session(doneEvent.languageDirective),
        requirements: {
          requirement:
            'Generate a short 4-slide lesson on Force in Hindi, including 2 explanation slides, 1 quiz, and 1 summary slide. Use simple Hindi throughout.',
        },
        sceneOutlines: doneEvent.outlines,
      },
      doneEvent.languageDirective,
    );
    const fetchProfile = vi.fn(async () => readyProfileResponse('hi'));

    const profile = await validateGenerationPreviewVoiceSelection(
      previewSession,
      fetchProfile as typeof fetch,
    );

    expect(previewSession.lessonLanguage).toBe('hi');
    expect(previewSession.sceneOutlines).toHaveLength(4);
    expect(profile).toMatchObject({ provider: 'indicf5', language: 'hi' });
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?profileId=vcp_selected&language=hi',
    );
  });

  it.each([
    ['Generate a lesson on motion in Hindi. Use simple Hindi throughout.', 'hi'],
    ['Generate a lesson on motion in Marathi. Use simple Marathi throughout.', 'mr'],
    ['Generate a lesson on motion in English. Use simple English throughout.', 'en'],
  ] as const)(
    'recovers %s from the requirement when the SSE directive is generic',
    (requirement, expected) => {
      const previewSession = session('Teach in the language that matches the user requirement.');
      previewSession.requirements.requirement = requirement;

      const normalized = normalizeGenerationPreviewLanguageState(previewSession);

      expect(normalized.lessonLanguage).toBe(expected);
    },
  );

  it('retains Hindi for valid early-language and done-only SSE event orders', () => {
    const previewSession = session('Teach in the language that matches the user requirement.');
    previewSession.requirements.requirement =
      'Generate a short lesson on Force in Hindi. Use simple Hindi throughout.';

    const earlyLanguageEvent = resolveGenerationPreviewLanguage(previewSession, {
      sseLanguage: 'hi',
      languageDirective: 'Teach in the language that matches the user requirement.',
    });
    const doneOnlyEvent = resolveGenerationPreviewLanguage(previewSession, {
      languageDirective: 'Teach in the language that matches the user requirement.',
    });

    expect(earlyLanguageEvent).toMatchObject({ language: 'hi', source: 'sse' });
    expect(doneOnlyEvent).toMatchObject({ language: 'hi', source: 'requirement' });
  });

  it('does not replace an invalid structured SSE language with a prompt-derived default', () => {
    const previewSession = session('Teach in the language that matches the user requirement.');
    previewSession.requirements.requirement = 'Generate the lesson in Hindi.';

    expect(
      resolveGenerationPreviewLanguage(previewSession, {
        sseLanguage: 'fr',
      }),
    ).toMatchObject({
      language: null,
      reason: 'invalid-structured-language',
    });
  });

  it('keeps an explicit Hindi Chatterbox synthesis preference independent of an English lesson', async () => {
    const previewSession = normalizeGenerationPreviewLanguageState(
      session('Teach the entire lesson in English.', 'en'),
    );
    const fetchProfile = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            profile: {
              id: 'vcp_selected',
              status: 'ready',
              provider: 'chatterbox',
              language: 'en',
              languageId: 'hi',
            },
          }),
        }) as Response,
    );

    const profile = await validateGenerationPreviewVoiceSelection(
      previewSession,
      fetchProfile as typeof fetch,
    );

    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?profileId=vcp_selected&language=en',
    );
    expect(profile).toMatchObject({ provider: 'chatterbox', language: 'en', languageId: 'hi' });
  });

  it.each([
    ['Teach the entire lesson in simple Hindi using Devanagari script.', 'hi'],
    ['Teach the entire lesson in Marathi using Devanagari script.', 'mr'],
    ['Teach the entire lesson in English using simple wording.', 'en'],
  ] as const)('sends only the normalized language for %s', async (directive, expected) => {
    const previewSession = normalizeGenerationPreviewLanguageState(session(directive));
    const fetchProfile = vi.fn(async (_url: string) => readyProfileResponse(expected));

    await validateGenerationPreviewVoiceSelection(previewSession, fetchProfile as typeof fetch);

    expect(previewSession).toMatchObject({
      teacherVoiceProfileId: 'vcp_selected',
      lessonLanguage: expected,
      sceneOutlines: [{ id: 'outline-1' }],
    });
    expect(fetchProfile).toHaveBeenCalledOnce();
    const requestedUrl = String(fetchProfile.mock.calls[0][0]);
    expect(requestedUrl).toBe(
      `/api/voice-cloning/profile?profileId=vcp_selected&language=${expected}`,
    );
    expect(requestedUrl).not.toContain(encodeURIComponent(directive));
    expect(requestedUrl).not.toContain('scene-outlines');
  });

  it('keeps persisted structured language authoritative across refresh hydration', async () => {
    const restored = session('Teach in English.', 'hi');
    const normalized = normalizeGenerationPreviewLanguageState(restored);
    const fetchProfile = vi.fn(async (_url: string) => readyProfileResponse('hi'));

    await validateGenerationPreviewVoiceSelection(normalized, fetchProfile as typeof fetch);

    expect(normalized).toBe(restored);
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?profileId=vcp_selected&language=hi',
    );
  });

  it('preserves the selected profile and generated outline after profile validation fails', async () => {
    const previewSession = normalizeGenerationPreviewLanguageState(
      session('Teach the entire lesson in Hindi.'),
    );
    const fetchProfile = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Selected Teaching Voice is not ready.' }),
    })) as unknown as typeof fetch;

    await expect(
      validateGenerationPreviewVoiceSelection(previewSession, fetchProfile),
    ).rejects.toBeInstanceOf(GenerationTeachingVoiceProfileError);
    expect(previewSession.teacherVoiceProfileId).toBe('vcp_selected');
    expect(previewSession.sceneOutlines).toHaveLength(1);
    expect(fetchProfile).toHaveBeenCalledOnce();
  });

  it('classifies a profile transport failure as recoverable preview validation', async () => {
    const previewSession = normalizeGenerationPreviewLanguageState(
      session('Teach the entire lesson in Hindi.'),
    );
    const fetchProfile = vi.fn().mockRejectedValue(new TypeError('network unavailable'));

    await expect(
      validateGenerationPreviewVoiceSelection(previewSession, fetchProfile as typeof fetch),
    ).rejects.toMatchObject({
      name: 'GenerationTeachingVoiceProfileError',
      message: 'Teaching Voice validation could not be completed. Try again.',
    });
    expect(previewSession.sceneOutlines).toHaveLength(1);
    expect(previewSession.teacherVoiceProfileId).toBe('vcp_selected');
  });

  it('rejects unsupported or ambiguous lesson language before profile transport', async () => {
    const fetchProfile = vi.fn();
    const unsupported = normalizeGenerationPreviewLanguageState(
      session('Teach the lesson in French.'),
    );

    await expect(
      validateGenerationPreviewVoiceSelection(unsupported, fetchProfile as typeof fetch),
    ).rejects.toThrow('unsupported or ambiguous');
    expect(unsupported.lessonLanguage).toBeUndefined();
    expect(fetchProfile).not.toHaveBeenCalled();
  });
});
