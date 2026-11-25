import { MANIM_VERSION, REFERENCE_TOPICS, type ReferenceTopic } from './skill';

const cache = new Map<ReferenceTopic, { until: number; text: string }>();
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_RESPONSE = 64 * 1024;

async function readBounded(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let content = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return content + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE) return '';
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The query is selected from a fixed vocabulary. Faculty content never leaves Sahaya. */
export async function findManimDocumentation(topic: ReferenceTopic, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!Object.hasOwn(REFERENCE_TOPICS, topic)) return undefined;
  const hit = cache.get(topic);
  if (hit && hit.until > Date.now()) return { text: hit.text, cached: true };
  const key = process.env.CONTEXT7_API_KEY?.trim();
  if (!key) return undefined;
  const url = new URL('https://context7.com/api/v2/context');
  url.search = new URLSearchParams({
    libraryId: `/manimcommunity/manim/v${MANIM_VERSION}`,
    query: `${REFERENCE_TOPICS[topic]} in Manim Community v${MANIM_VERSION}`,
    type: 'json',
  }).toString();
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2200)]),
      redirect: 'error',
      cache: 'no-store',
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return undefined;
    }
    const result = JSON.parse(await readBounded(response)) as {
      version?: { status?: string; served?: string };
      infoSnippets?: { pageId?: string; content?: string }[];
      codeSnippets?: {
        codeId?: string;
        codeDescription?: string;
        codeList?: { code?: string }[];
      }[];
    };
    // Context7 can return HTTP 200 with an explicitly different served version.
    const version = result.version;
    const pinned = version?.status === 'verified' && version.served === `v${MANIM_VERSION}`;
    if (version && !pinned) return undefined;
    const exactTag = /^https:\/\/github\.com\/manimcommunity\/manim\/(?:blob|tree)\/v0\.22\.1\//i;
    const upstream =
      /^https:\/\/(?:github\.com\/manimcommunity\/manim\/|docs\.manim\.community\/)/i;
    const sourceMatches = (url?: string) =>
      typeof url === 'string' && (exactTag.test(url) || (pinned && upstream.test(url)));
    const info = (Array.isArray(result.infoSnippets) ? result.infoSnippets : [])
      .filter((entry) => entry && sourceMatches(entry.pageId) && typeof entry.content === 'string')
      .map((entry) => entry.content);
    const code = (Array.isArray(result.codeSnippets) ? result.codeSnippets : [])
      .filter((entry) => entry && sourceMatches(entry.codeId))
      .flatMap((entry) =>
        Array.isArray(entry.codeList) ? entry.codeList.map((item) => item?.code) : [],
      );
    const text = [...info, ...code]
      .filter((part) => typeof part === 'string')
      .join('\n\n')
      .slice(0, 4300);
    if (!text) return undefined;
    cache.set(topic, { text, until: Date.now() + TTL_MS });
    return { text, cached: false };
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}
