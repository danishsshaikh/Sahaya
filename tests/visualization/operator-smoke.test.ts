import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: probe }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('submits a trusted temporary preview and verifies its media through the existing protocol', async () => {
  const video = Buffer.from('0000ftyp-smoke-data');
  const hash = createHash('sha256').update(video).digest('hex');
  const image = `sha256:${'a'.repeat(64)}`;
  const artifactId = 'b'.repeat(64);
  const meta = {
    artifactId,
    sandboxImage: image,
    quality: 'preview',
    sourceFormat: 'python',
    verification: { media: 'decoded' },
    cues: [{ id: 'fixture', start: 0, end: 1 }],
    duration: 1,
    fps: 15,
    width: 854,
    height: 480,
    bytes: video.length,
    sha256: hash,
  };
  probe.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      streams: [
        {
          codec_name: 'h264',
          codec_type: 'video',
          width: 854,
          height: 480,
          avg_frame_rate: '15/1',
          nb_frames: '15',
        },
      ],
    }),
  });
  vi.stubEnv('MANIM_RENDERER_TOKEN', 'operator-test-token-at-least-24');
  vi.stubEnv('MANIM_RENDERER_URL', 'http://publisher.example');
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer operator-test-token-at-least-24',
    );
    if (url.endsWith('/ready'))
      return Response.json({
        protocol: 4,
        backend: 'bubblewrap',
        isolation: 'verified',
        secureExecution: true,
        sandboxImage: image,
      });
    if (url.endsWith('/jobs')) {
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toMatchObject({
        quality: 'preview',
        publication: 'preview',
        source: expect.stringContaining('Create(Square())'),
      });
      return Response.json({ status: 'completed', artifact: meta });
    }
    expect(url).toBe(`http://publisher.example/artifacts/${artifactId}/video.mp4`);
    return new Response(video, { headers: { 'Content-Length': String(video.length) } });
  });
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('../../scripts/smoke-manim-renderer');
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"status":"verified"')),
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  const owners = fetch.mock.calls.map(([, init]) => new Headers(init.headers).get('X-Manim-Owner'));
  expect(new Set(owners).size).toBe(1);
  expect(owners[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(probe).toHaveBeenCalledWith(
    'ffprobe',
    expect.any(Array),
    expect.objectContaining({ input: video }),
  );
});
