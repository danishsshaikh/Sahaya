import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';

const FEATURE_ENV_KEYS = [
  'NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES',
  'NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES',
  'NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES',
  'NEXT_PUBLIC_FEATURE_FLOW_SCENES',
] as const;

const originalEnv = { ...process.env };

function baseOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Foundations',
    description: 'Introduce the concept.',
    keyPoints: ['One', 'Two', 'Three'],
    order: 1,
    ...overrides,
  };
}

async function loadFallbacks(env: Partial<Record<(typeof FEATURE_ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of FEATURE_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return import('@/lib/generation/outline-generator');
}

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe('scene outline stream Sahaya feature fallbacks', () => {
  it('falls back PBL/workspace outlines while workspace scenes are disabled', async () => {
    const { applySahayaOutlineFeatureFallbacks } = await loadFallbacks({});
    const outline = baseOutline({
      type: 'pbl',
      pblConfig: {
        projectTopic: 'Bridge design',
        projectDescription: 'Design and review a bridge.',
        targetSkills: ['analysis'],
      },
    });

    const fallback = applySahayaOutlineFeatureFallbacks(outline, {
      taskEngineMode: false,
      hasLanguageModel: true,
    });

    expect(fallback.type).toBe('slide');
    expect(fallback).not.toHaveProperty('widgetType');
    expect(fallback).not.toHaveProperty('pblConfig');
  });

  it('keeps deterministic simulation outlines under Sahaya defaults', async () => {
    const { applySahayaOutlineFeatureFallbacks } = await loadFallbacks({});
    const outline = baseOutline({
      type: 'interactive',
      widgetType: 'simulation',
      widgetOutline: { concept: 'Projectile motion', keyVariables: ['angle', 'velocity'] },
    });

    expect(
      applySahayaOutlineFeatureFallbacks(outline, {
        taskEngineMode: false,
        hasLanguageModel: true,
      }),
    ).toMatchObject({ type: 'interactive', widgetType: 'simulation' });
  });

  it('falls back flow diagrams while flow scenes are disabled', async () => {
    const { applySahayaOutlineFeatureFallbacks } = await loadFallbacks({
      NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES: 'true',
    });
    const outline = baseOutline({
      type: 'interactive',
      widgetType: 'diagram',
      widgetOutline: { concept: 'Signal path', diagramType: 'flowchart' },
    });

    const fallback = applySahayaOutlineFeatureFallbacks(outline, {
      taskEngineMode: false,
      hasLanguageModel: true,
    });

    expect(fallback.type).toBe('slide');
    expect(fallback).not.toHaveProperty('widgetType');
    expect(fallback).not.toHaveProperty('widgetOutline');
  });
});
