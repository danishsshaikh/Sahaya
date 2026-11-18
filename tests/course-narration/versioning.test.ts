import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/types/stage';
import type { CourseNarrationVersion } from '@/lib/course-narration/types';
import {
  applyNarrationVersion,
  captureOriginalNarration,
  courseNarrationContentFingerprint,
  ensureOriginalNarrationState,
  isNarrationVersionStale,
  sceneNarrationText,
  versionMatchesSelection,
} from '@/lib/course-narration/versioning';
import { VOICE_COMPARISON_PROVIDERS } from '@/lib/voice-comparison/catalog';

function scene(id: string, order: number, text: string, audioId = `audio-${id}`): Scene {
  return {
    id,
    stageId: 'course-1',
    title: `Scene ${order}`,
    order,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
    actions: [
      { id: `visual-${id}`, type: 'wait', duration: 250 },
      { id: `speech-${id}`, type: 'speech', text, audioId },
    ],
  } as Scene;
}

describe('course narration versions', () => {
  it('captures the original audio without changing transcript, scenes, or visuals', () => {
    const scenes = [scene('one', 1, '  Exact text stays.  ')];
    const before = structuredClone(scenes);
    const original = captureOriginalNarration(scenes, 'en', 'Qwen3-TTS 1.7B');

    expect(original.scenes.one.clips['speech-one']).toMatchObject({
      transcript: '  Exact text stays.  ',
      audioId: 'audio-one',
    });
    expect(scenes).toEqual(before);
  });

  it('keeps multiple providers side by side and restores each version without synthesis', () => {
    const scenes = [scene('one', 1, 'Newton stays at rest.')];
    const original = captureOriginalNarration(scenes, 'en');
    const qwen: CourseNarrationVersion = {
      ...structuredClone(original),
      id: 'qwen-version',
      providerId: 'qwen3-tts',
      providerName: 'Qwen3-TTS 1.7B',
      scenes: {
        one: {
          sceneId: 'one',
          clips: {
            'speech-one': {
              transcript: 'Newton stays at rest.',
              transcriptFingerprint: 'same',
              audioId: 'qwen-audio',
              durationSeconds: 10,
            },
          },
        },
      },
    };
    const state = ensureOriginalNarrationState(
      { schemaVersion: 1, activeVersionId: original.id, versions: [original, qwen] },
      scenes,
      'en',
    );

    expect(state.versions.map((version) => version.providerId)).toEqual(['original', 'qwen3-tts']);
    const activated = applyNarrationVersion(scenes, qwen);
    expect(activated[0].actions?.find((action) => action.type === 'speech')?.audioId).toBe(
      'qwen-audio',
    );
    expect(activated[0].content).toEqual(scenes[0].content);
    expect(activated[0].id).toBe(scenes[0].id);
  });

  it('refuses partial or stale activation and marks transcript edits outdated', () => {
    const scenes = [scene('one', 1, 'Before edit')];
    const version = captureOriginalNarration(scenes, 'en');
    const edited = [scene('one', 1, 'After edit')];

    expect(isNarrationVersionStale(version, edited)).toBe(true);
    expect(() => applyNarrationVersion(edited, version)).toThrow(/outdated/);
    expect(() => applyNarrationVersion(scenes, { ...version, status: 'failed' })).toThrow(
      /not complete/,
    );
  });

  it('uses exact ordered speech text for preview and revision fingerprints', () => {
    const value = scene('one', 1, ' First line ');
    value.actions?.push({ id: 'speech-two', type: 'speech', text: 'Second line.' });
    expect(sceneNarrationText(value)).toBe(' First line \nSecond line.');
    expect(courseNarrationContentFingerprint([value])).toContain(' First line ');
  });

  it('reuses a completed identical saved selection but not a different provider/settings', () => {
    const scenes = [scene('one', 1, 'Same transcript')];
    const version: CourseNarrationVersion = {
      ...captureOriginalNarration(scenes, 'en'),
      id: 'saved',
      providerId: 'bodhan',
      providerName: 'Bodhan Indic-Speak',
      settings: { voice: 'Prastuti', style: 'educational lecture' },
    };
    expect(
      versionMatchesSelection(
        version,
        {
          providerId: 'bodhan',
          providerName: version.providerName,
          language: 'en',
          voice: 'Prastuti',
          style: 'educational lecture',
        },
        scenes,
      ),
    ).toBe(true);
    expect(
      versionMatchesSelection(
        version,
        { providerId: 'sarvam', providerName: 'Sarvam AI', language: 'en' },
        scenes,
      ),
    ).toBe(false);
  });

  it('identifies Original and Enhanced Qwen narration as independent saved versions', () => {
    const scenes = [scene('one', 1, 'Same transcript')];
    const originalQwen: CourseNarrationVersion = {
      ...captureOriginalNarration(scenes, 'en'),
      id: 'qwen-original',
      providerId: 'qwen3-tts',
      providerName: 'Qwen3-TTS (Original)',
      settings: { enhancementMode: 'standard', processingMode: 'model-native-output' },
    };

    expect(
      versionMatchesSelection(
        originalQwen,
        {
          providerId: 'qwen3-tts',
          providerName: 'Qwen3-TTS (Original)',
          language: 'en',
          enhancementMode: 'standard',
        },
        scenes,
      ),
    ).toBe(true);
    expect(
      versionMatchesSelection(
        originalQwen,
        {
          providerId: 'qwen3-tts',
          providerName: 'Qwen3-TTS (Enhanced)',
          language: 'en',
          enhancementMode: 'resemble-enhance',
        },
        scenes,
      ),
    ).toBe(false);
  });

  it('declares course narration capability separately for all six adapters', () => {
    expect(
      Object.fromEntries(
        VOICE_COMPARISON_PROVIDERS.map((provider) => [
          provider.id,
          provider.supportsCourseNarration,
        ]),
      ),
    ).toEqual({
      chatterbox: true,
      'qwen3-tts': true,
      sarvam: true,
      bodhan: true,
      'ming3-tts': true,
      indicf5: true,
    });
    expect(
      VOICE_COMPARISON_PROVIDERS.filter((provider) => provider.experimental).map(
        (provider) => provider.id,
      ),
    ).toEqual(['sarvam', 'bodhan', 'ming3-tts']);
  });

  it('round-trips legacy-compatible narration metadata through persisted stage JSON', () => {
    const scenes = [scene('one', 1, 'Persisted transcript')];
    const original = captureOriginalNarration(scenes, 'en', 'Qwen3-TTS 1.7B');
    const stage = {
      id: 'course-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      narration: {
        schemaVersion: 1 as const,
        activeVersionId: 'original',
        versions: [original],
        preferredSelection: {
          providerId: 'qwen3-tts' as const,
          providerName: 'Qwen3-TTS (Original)',
          language: 'en' as const,
          enhancementMode: 'standard' as const,
        },
      },
    };

    expect(JSON.parse(JSON.stringify(stage))).toEqual(stage);
  });
});
