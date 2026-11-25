import type { LanguageModel } from 'ai';
import { callLLM, streamLLM, type LLMRoutingPolicy, type ThinkingConfig } from '@/lib/ai/llm';
import { manimAgentBudget } from './budget';
import { manimTurnRouting, type VisualizationAiCall } from './generate';

export function dedicatedManimModel() {
  return process.env.MANIM_MODEL_PRIMARY_MODEL?.trim() || undefined;
}

export function createManimAiCall({
  model,
  outputWindow,
  thinking,
  timing = {},
}: {
  model: LanguageModel;
  outputWindow?: number;
  thinking?: ThinkingConfig;
  timing?: LLMRoutingPolicy;
}): VisualizationAiCall {
  return async (system, prompt, abortSignal, tools, turn) => {
    const limits = manimAgentBudget();
    const routed = dedicatedManimModel() || process.env.LLM_ROUTER_ENABLED === 'true';
    const requestedCompletionTokens = Math.min(
      turn?.completionTokens ?? limits.completionTokens,
      routed ? Infinity : (outputWindow ?? Infinity),
    );
    const params = {
      model,
      system,
      prompt,
      abortSignal,
      maxRetries: 0,
      maxOutputTokens: requestedCompletionTokens,
      ...(routed ? {} : { timeout: limits.inferenceMs }),
      ...(tools && { tools, toolChoice: 'required' as const }),
    };
    const policy = manimTurnRouting(timing, turn);
    if (process.env.MANIM_AGENT_STREAM !== 'true') {
      const result = await callLLM(params, 'manim-authoring', undefined, thinking, policy);
      return {
        text: result.text,
        toolCalls: result.toolCalls,
        usage: result.usage,
        reasoningText: result.reasoningText,
        finishReason: result.finishReason,
        response: result.response,
        requestedCompletionTokens,
      };
    }

    const started = Date.now();
    const result = streamLLM({ ...params, onError: () => {} }, 'manim-authoring', thinking, policy);
    let firstTokenMs: number | undefined;
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (
        firstTokenMs === undefined &&
        (part.type === 'text-delta' || part.type === 'reasoning-delta') &&
        part.text
      ) {
        firstTokenMs = Date.now() - started;
        turn?.onFirstToken?.(firstTokenMs);
      }
    }
    abortSignal.throwIfAborted();
    const [text, toolCalls, usage, reasoningText, finishReason, response] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.reasoningText,
      result.finishReason,
      result.response,
    ]);
    return {
      text,
      toolCalls,
      usage,
      reasoningText,
      finishReason,
      response,
      firstTokenMs,
      requestedCompletionTokens,
    };
  };
}
