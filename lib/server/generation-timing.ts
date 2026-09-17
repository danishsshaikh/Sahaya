import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/logger';
import type { LLMRouteTelemetry, LLMRoutingPolicy } from '@/lib/server/llm-router';

const sceneLog = createLogger('SceneGenerationTiming');
const courseLog = createLogger('CourseGenerationTiming');

export type GenerationPhase = 'content' | 'actions' | 'course';

export interface GenerationTimingCollector {
  requestId: string;
  events: LLMRouteTelemetry[];
  routingPolicy: LLMRoutingPolicy;
}

export interface SceneGenerationTimingRecord {
  requestId: string;
  phase: GenerationPhase;
  stageId?: string;
  outlineId?: string;
  sceneId?: string;
  sceneType?: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  elementCount?: number;
  actionCount?: number;
  retryAttempts?: number;
  providerRole?: LLMRouteTelemetry['selectedRole'];
  providerId?: string;
  modelId?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  llmAttempts?: number;
}

export function createGenerationTimingCollector(
  requestId: string = randomUUID(),
): GenerationTimingCollector {
  const events: LLMRouteTelemetry[] = [];
  return {
    requestId,
    events,
    routingPolicy: {
      requestId,
      onRouteEvent: (event) => {
        events.push(event);
      },
    },
  };
}

export function shouldCollectLLMRouteTiming(): boolean {
  return process.env.LLM_ROUTER_ENABLED === 'true';
}

function latestRouteEvent(events: readonly LLMRouteTelemetry[]): LLMRouteTelemetry | undefined {
  return events.at(-1);
}

export function withRouteTiming(
  record: Omit<
    SceneGenerationTimingRecord,
    'providerRole' | 'providerId' | 'modelId' | 'fallbackUsed' | 'fallbackReason' | 'llmAttempts'
  >,
  events: readonly LLMRouteTelemetry[],
): SceneGenerationTimingRecord {
  const latest = latestRouteEvent(events);
  return {
    ...record,
    ...(latest
      ? {
          providerRole: latest.selectedRole,
          providerId: latest.selectedProvider,
          modelId: latest.selectedModel,
          fallbackUsed: latest.fallbackUsed,
          ...(latest.fallbackReason ? { fallbackReason: latest.fallbackReason } : {}),
          llmAttempts: Math.max(...events.map((event) => event.attempt), 0),
        }
      : {}),
  };
}

export function logSceneGenerationTiming(record: SceneGenerationTimingRecord): void {
  sceneLog.info(record);
}

export function logCourseGenerationTiming(record: {
  requestId: string;
  status: 'success' | 'failed';
  durationMs: number;
  sceneCount: number;
  generatedSceneCount: number;
  failedSceneCount: number;
  contentDurationMs: number;
  actionsDurationMs: number;
  mediaDurationMs?: number;
  ttsDurationMs?: number;
}): void {
  courseLog.info(record);
}
