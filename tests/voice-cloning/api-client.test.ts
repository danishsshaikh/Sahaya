import { describe, expect, it } from 'vitest';
import {
  VoiceApiClientError,
  readVoiceApiResponse,
  voiceFetchError,
} from '@/lib/voice-cloning/api-client';

function response(body: BodyInit | null, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe('Teaching Voice API response parser', () => {
  it('parses application/json success', async () => {
    await expect(
      readVoiceApiResponse(
        response(JSON.stringify({ success: true, value: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).resolves.toEqual({ success: true, value: 1 });
  });

  it('uses JSON application error messages', async () => {
    await expect(
      readVoiceApiResponse(
        response(JSON.stringify({ success: false, error: 'Bad recording' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).rejects.toMatchObject({ message: 'Bad recording', kind: 'http', status: 400 });
  });

  it('turns HTML proxy errors into controlled errors', async () => {
    await expect(
      readVoiceApiResponse(
        response('<!DOCTYPE html><title>Gateway timeout</title>', {
          status: 504,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    ).rejects.toMatchObject({
      kind: 'non-json',
      status: 504,
      message: 'Teaching Voice service could not be confirmed. Checking status may recover it.',
    });
  });

  it('turns text/plain responses into controlled errors', async () => {
    await expect(
      readVoiceApiResponse(
        response('bad gateway', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'non-json', status: 502 });
  });

  it('handles empty error bodies without JSON parser exceptions', async () => {
    await expect(readVoiceApiResponse(response(null, { status: 500 }))).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });

  it('normalizes network and abort failures', () => {
    expect(voiceFetchError(new TypeError('fetch failed'))).toMatchObject({
      kind: 'network',
      message: 'Teaching Voice connection was interrupted.',
    });
    expect(voiceFetchError(new DOMException('aborted', 'AbortError'))).toMatchObject({
      kind: 'aborted',
      message: 'Teaching Voice request was interrupted.',
    });
    expect(voiceFetchError(new VoiceApiClientError('custom', 'parse', 200))).toMatchObject({
      kind: 'parse',
      message: 'custom',
    });
  });
});
