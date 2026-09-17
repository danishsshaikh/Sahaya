import { describe, expect, it } from 'vitest';
import { createGenerationTimingCollector, withRouteTiming } from '@/lib/server/generation-timing';

describe('generation timing metadata', () => {
  it('collects router events without prompt or response content', () => {
    const collector = createGenerationTimingCollector('timing-test');
    collector.routingPolicy.onRouteEvent?.({
      requestId: 'timing-test',
      source: 'scene-content',
      selectedRole: 'fallback',
      selectedProvider: 'openai-compatible',
      selectedModel: 'gemma-local',
      fallbackUsed: true,
      fallbackReason: 'timeout',
      circuitState: 'CLOSED',
      status: 'success',
      timeoutBudgetMs: 120000,
      latencyMs: 3812,
      attempt: 2,
    });

    const record = withRouteTiming(
      {
        requestId: collector.requestId,
        phase: 'content',
        stageId: 'stage-1',
        outlineId: 'outline-1',
        sceneType: 'slide',
        status: 'success',
        durationMs: 4000,
        elementCount: 4,
      },
      collector.events,
    );

    expect(record).toMatchObject({
      requestId: 'timing-test',
      providerRole: 'fallback',
      providerId: 'openai-compatible',
      modelId: 'gemma-local',
      fallbackUsed: true,
      fallbackReason: 'timeout',
      llmAttempts: 2,
    });
    expect(JSON.stringify(record)).not.toContain('prompt');
    expect(JSON.stringify(record)).not.toContain('response');
  });
});
