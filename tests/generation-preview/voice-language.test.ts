import { describe, expect, it, vi } from 'vitest';
import type { GenerationSessionState } from '@/app/generation-preview/types';
import {
  normalizeGenerationPreviewLanguageState,
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
