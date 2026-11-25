import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { VisualizationFailure } from '@/lib/visualization/failure';
import { diagnoseManimAuthoring } from '@/lib/visualization/generate';
import { loadManimKnowledge } from '@/lib/visualization/knowledge';
import { preflightCandidate } from '@/lib/visualization/preflight';
import { verifyPublishedPreview } from '@/lib/visualization/preview-verification';
import { getVisualizationCapability } from '@/lib/visualization/renderer';
import { extractSubmission } from '@/lib/visualization/submission';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

async function main() {
  const { values } = parseArgs({
    options: { render: { type: 'boolean' }, only: { type: 'string', multiple: true } },
  });
  const { index, examples } = await loadManimKnowledge();
  const selected = values.only
    ? examples.filter((example) => values.only?.includes(example.id))
    : examples;
  if (
    !selected.length ||
    (values.only && values.only.some((id) => !selected.some((item) => item.id === id)))
  )
    throw new Error('Unknown example ID');
  const ready = await getVisualizationCapability();
  if (!ready.available || ready.apiPreflight !== index.version)
    throw new Error('A verified publisher with matching Manim preflight is required');
  // This operator tool verifies trusted fixtures and has no model or remote documentation calls.
  process.env.CONTEXT7_API_KEY = '';
  let failures = 0;
  for (const example of selected) {
    controller.signal.throwIfAborted();
    try {
      const parsed = extractSubmission({ text: example.source });
      if (parsed.outcome !== 'submitted')
        throw new VisualizationFailure('VISUALIZATION_RESPONSE_FORMAT');
      const ownerId = `manim-example-${randomUUID()}`;
      const checked = await preflightCandidate(ownerId, parsed.candidate, controller.signal);
      if (checked.issue || checked.normalization)
        throw new VisualizationFailure(
          'VISUALIZATION_PYTHON_VALIDATION',
          checked.issue?.code ?? 'normalization',
        );
      console.log(
        JSON.stringify({
          example: example.id,
          version: checked.version,
          status: 'static-validated',
        }),
      );
      if (!values.render) continue;

      const outline = {
        id: example.id,
        title: example.title,
        description: example.title,
        keyPoints: [],
        order: 1,
        type: 'visualization' as const,
      };
      const { artifact } = await diagnoseManimAuthoring(
        {
          ownerId,
          outline,
          allOutlines: [outline],
          aiCall: async () => example.source,
          signal: controller.signal,
        },
        { preview: true, validate: () => checked },
      );
      if (!artifact) throw new VisualizationFailure('VISUALIZATION_ARTIFACT_VALIDATION');
      await verifyPublishedPreview(ownerId, artifact, controller.signal);
      console.log(
        JSON.stringify({
          example: example.id,
          status: 'rendered-and-verified',
          artifactId: artifact.artifactId,
        }),
      );
    } catch (error) {
      controller.signal.throwIfAborted();
      failures++;
      console.error(
        JSON.stringify({
          example: example.id,
          status: 'failed',
          failureCode:
            error instanceof VisualizationFailure ? error.code : 'publisher_request_failed',
          reason: error instanceof VisualizationFailure ? error.detail : undefined,
        }),
      );
    }
  }
  if (failures) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Example verification failed');
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
