export class VoiceApiClientError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'non-json' | 'network' | 'aborted' | 'parse',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceApiClientError';
  }
}

function safeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function httpMessage(status: number): string {
  if (status >= 500)
    return 'Teaching Voice service could not be confirmed. Checking status may recover it.';
  if (status === 404) return 'Teaching Voice enrollment was not found or expired.';
  if (status === 401 || status === 403) return 'You are not authorized to use Teaching Voice.';
  return 'Teaching Voice request failed.';
}

export async function readVoiceApiResponse<T extends Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const isJson = contentType.toLowerCase().includes('application/json');

  if (!text) {
    if (response.ok) return {} as T;
    throw new VoiceApiClientError(httpMessage(response.status), 'http', response.status);
  }

  if (!isJson) {
    throw new VoiceApiClientError(
      response.ok
        ? 'Teaching Voice returned an unexpected response.'
        : httpMessage(response.status),
      'non-json',
      response.status,
    );
  }

  try {
    const parsed = JSON.parse(text) as T & { error?: unknown; details?: unknown };
    if (!response.ok) {
      const message =
        typeof parsed.details === 'string'
          ? parsed.details
          : typeof parsed.error === 'string'
            ? parsed.error
            : httpMessage(response.status);
      throw new VoiceApiClientError(message, 'http', response.status);
    }
    return parsed;
  } catch (error) {
    if (error instanceof VoiceApiClientError) throw error;
    throw new VoiceApiClientError(
      `Teaching Voice returned invalid JSON${safeSnippet(text) ? ` (${safeSnippet(text)})` : ''}.`,
      'parse',
      response.status,
    );
  }
}

export function voiceFetchError(error: unknown): VoiceApiClientError {
  if (error instanceof VoiceApiClientError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new VoiceApiClientError('Teaching Voice request was interrupted.', 'aborted');
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new VoiceApiClientError('Teaching Voice request was interrupted.', 'aborted');
  }
  return new VoiceApiClientError('Teaching Voice connection was interrupted.', 'network');
}
