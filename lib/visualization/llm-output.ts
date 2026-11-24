import { Output } from 'ai';

/** JSON mode is safe on known native OpenAI transports. A routed call can
 * change transports during failover, so it uses the same JSON prompt on every
 * tier and relies on the renderer schema for validation.
 */
export function visualizationJsonOutput(providerId: string, modelString: string, baseUrl?: string) {
  if (
    process.env.LLM_ROUTER_ENABLED === 'true' ||
    providerId !== 'openai' ||
    (baseUrl && !/^https:\/\/api\.openai\.com\/v1\/?$/.test(baseUrl)) ||
    !/^openai:gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelString)
  ) {
    return {};
  }
  return { output: Output.json() };
}
