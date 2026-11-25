import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readRenderJob,
  rendererFetch,
  RendererError,
  type RenderJob,
} from '@/lib/visualization/renderer';

// Trusted operator fixture. The unique owner keeps it outside classroom storage.
const source = `from manim import Create, Square
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("fixture"):
            self.play(Create(Square()), run_time=1.0)
`;
const owner = `sahaya-renderer-smoke-${randomUUID()}`;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(150_000)]);
const hex = /^[a-f0-9]{64}$/;

async function main() {
  const ready = await rendererFetch(owner, '/ready', { signal });
  const capability = await ready.json();
  if (
    !ready.ok ||
    capability.protocol !== 4 ||
    capability.backend !== 'bubblewrap' ||
    capability.isolation !== 'verified' ||
    capability.secureExecution !== true
  )
    throw new Error('bubblewrap_unverified');

  let job: RenderJob | undefined;
  let id: string | undefined;
  try {
    job = await readRenderJob(
      await rendererFetch(owner, '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          source,
          segments: [{ id: 'fixture', narration: 'The square appears.' }],
          quality: 'preview',
          publication: 'preview',
          minimums: {},
        }),
      }),
    );
    id = job.id && hex.test(job.id) ? job.id : undefined;
    while (id && ['queued', 'rendering', 'processing'].includes(job.status)) {
      await delay(1000, undefined, { signal });
      job = await readRenderJob(await rendererFetch(owner, `/jobs/${id}`, { signal }));
    }
    if (job.status !== 'completed' || !job.artifact) throw new RendererError(422, job.issue);

    const meta = job.artifact;
    if (
      !hex.test(meta.artifactId) ||
      !hex.test(meta.sha256) ||
      meta.quality !== 'preview' ||
      meta.sourceFormat !== 'python' ||
      meta.sandboxImage !== capability.sandboxImage ||
      meta.verification?.media !== 'decoded' ||
      meta.cues.length !== 1 ||
      meta.cues[0].id !== 'fixture' ||
      meta.cues[0].start !== 0 ||
      meta.cues[0].end !== meta.duration
    )
      throw new Error('artifact_metadata_invalid');

    const response = await rendererFetch(
      owner,
      `/artifacts/${meta.artifactId}/video.mp4`,
      { signal },
      true,
    );
    const size = Number(response.headers.get('Content-Length'));
    if (!response.ok || size !== meta.bytes || size < 16 || size > 10 * 1024 * 1024)
      throw new Error('artifact_size_invalid');
    const data = Buffer.from(await response.arrayBuffer());
    if (
      data.length !== size ||
      data.toString('ascii', 4, 8) !== 'ftyp' ||
      createHash('sha256').update(data).digest('hex') !== meta.sha256
    )
      throw new Error('artifact_hash_invalid');

    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', '-i', 'pipe:0'],
      { input: data, encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 },
    );
    if (probe.status !== 0) throw new Error('ffprobe_failed');
    const streams = JSON.parse(probe.stdout).streams;
    const video = streams[0];
    if (
      streams.length !== 1 ||
      video.codec_name !== 'h264' ||
      video.codec_type !== 'video' ||
      video.width !== meta.width ||
      video.height !== meta.height ||
      video.avg_frame_rate !== `${meta.fps}/1` ||
      Number(video.nb_frames) !== Math.round(meta.duration * meta.fps)
    )
      throw new Error('artifact_stream_invalid');
    console.log(
      JSON.stringify({
        status: 'verified',
        backend: capability.backend,
        jobId: id,
        artifactId: meta.artifactId,
        sha256: meta.sha256,
        bytes: size,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        duration: meta.duration,
      }),
    );
  } finally {
    if (id && job && ['queued', 'rendering', 'processing'].includes(job.status))
      await rendererFetch(owner, `/jobs/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
  }
}

void main().catch((error: unknown) => {
  const code =
    error instanceof RendererError
      ? error.issue?.code
      : error instanceof Error
        ? error.message
        : undefined;
  console.error(
    JSON.stringify({
      status: 'failed',
      reason: signal.aborted
        ? abort.signal.aborted
          ? 'cancelled'
          : 'deadline'
        : code && /^[a-zA-Z_]{1,48}$/.test(code)
          ? code
          : 'renderer_smoke_failed',
    }),
  );
  process.exitCode = abort.signal.aborted ? 130 : 1;
});
