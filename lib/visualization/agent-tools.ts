import { tool } from 'ai';
import { z } from 'zod';

const topics = z.enum(['layout', 'plotting', 'camera', 'timing', 'rendering']);
const segment = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
    narration: z.string().trim().min(1).max(420).optional(),
    caption: z.string().trim().min(1).max(420).optional(),
  })
  .strict();

export const sourceSubmission = z
  .object({
    source: z
      .string()
      .min(1)
      .max(48 * 1024),
    segments: z.array(segment).min(1).max(24),
  })
  .strict()
  .refine(
    ({ segments, source }) =>
      Buffer.byteLength(source) <= 48 * 1024 &&
      new Set(segments.map((cue) => cue.id)).size === segments.length &&
      segments.some((cue) => cue.narration),
  );

export const submitSceneTools = {
  submit_scene: tool({
    description:
      'Submit the complete Python module and its ordered narration/caption metadata for checks and a preview.',
    inputSchema: sourceSubmission,
  }),
};

const topicBatch = z.object({ topics: z.array(topics).min(1).max(3) }).strict();
const referenceRequest = z.union([topicBatch, z.object({ topic: topics }).strict()]);

export function requestedReferenceTopics(input: unknown) {
  const result = referenceRequest.safeParse(input);
  if (!result.success) return undefined;
  return 'topics' in result.data ? result.data.topics : [result.data.topic];
}

export const manimTools = {
  ...submitSceneTools,
  read_reference: tool({
    description: 'Request up to three missing Manim references together for the next turn.',
    inputSchema: topicBatch,
  }),
};

export function supportsNativeManimTools(provider: string, model: string, baseUrl?: string) {
  return (
    process.env.LLM_ROUTER_ENABLED !== 'true' &&
    provider === 'openai' &&
    (!baseUrl || /^https:\/\/api\.openai\.com\/v1\/?$/.test(baseUrl)) &&
    /^openai:gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
  );
}
