import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { rendererFetch } from '@/lib/visualization/renderer';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const user = await requireSessionUser(request);
  if (user instanceof Response) return user;
  const { id, file } = await params;
  if (!/^[a-f0-9]{64}$/.test(id) || (file !== 'video.mp4' && file !== 'poster.jpg')) {
    return new Response(null, { status: 404 });
  }
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);
  try {
    const upstream = await rendererFetch(
      user.id,
      `/artifacts/${id}/${file}`,
      { headers, signal: request.signal },
      true,
    );
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    }
    const forwarded = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = upstream.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: forwarded });
  } catch {
    return new Response(null, { status: 503 });
  }
}
