import { createHash } from 'node:crypto';
import { VisualizationFailure } from './failure';
import { rendererFetch, type RenderJob } from './renderer';

export async function verifyPublishedPreview(
  ownerId: string,
  artifact: NonNullable<RenderJob['artifact']>,
  parent: AbortSignal,
) {
  const expectedSize = artifact.bytes;
  const invalid = () =>
    new VisualizationFailure('VISUALIZATION_ARTIFACT_VALIDATION', 'diagnostic_preview_invalid');
  if (
    artifact.verification?.media !== 'decoded' ||
    artifact.quality !== 'preview' ||
    !/^[a-f0-9]{64}$/.test(artifact.artifactId) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 16 ||
    expectedSize > 50 * 1024 * 1024
  )
    throw invalid();
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
  const response = await rendererFetch(
    ownerId,
    `/artifacts/${artifact.artifactId}/video.mp4`,
    { signal },
    true,
  );
  const reader = response.body?.getReader();
  if (!response.ok || !reader || Number(response.headers.get('Content-Length')) !== expectedSize) {
    await reader?.cancel();
    throw invalid();
  }
  const hash = createHash('sha256');
  const header = Buffer.alloc(8);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > expectedSize) throw invalid();
      if (size < header.length) header.set(value.subarray(0, header.length - size), size);
      size += value.byteLength;
      hash.update(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (
    size !== expectedSize ||
    header.toString('ascii', 4) !== 'ftyp' ||
    hash.digest('hex') !== artifact.sha256
  )
    throw invalid();
}
