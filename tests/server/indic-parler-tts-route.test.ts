import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/generate/tts/route';

const mocks = vi.hoisted(() => ({ teaching: vi.fn(), usage: vi.fn(), ssrf: vi.fn() }));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: mocks.ssrf }));
vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: vi.fn(async () => ({ id: 'faculty-test' })),
}));
vi.mock('@/lib/voice-cloning/synthesis', () => ({ synthesizeFacultyVoice: mocks.teaching }));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => true,
  isServerTTSProviderDisabled: () => false,
  resolveTTSApiKey: () => '',
  resolveTTSBaseUrl: () => 'http://127.0.0.1:8770',
  resolveTTSModel: () => undefined,
  TTSModelNotAllowedError: class extends Error {},
}));
const fetchMock = vi.fn<typeof fetch>();
const wav = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 65, 86, 69, 0, 0, 0, 0]);
function request(extra: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'A lesson.',
      audioId: 'preview',
      ttsProviderId: 'indic-parler-tts',
      ttsVoice: 'default',
      ...extra,
    }),
  });
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(
      async () => new Response(wav, { headers: { 'content-type': 'audio/wav' } }),
    );
  mocks.teaching.mockReset();
  mocks.usage.mockReset();
  mocks.ssrf.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Indic Parler through the normal TTS route', () => {
  it('previews/generates managed keyless WAV and ignores client URL overrides', async () => {
    const response = await POST(
      request({ ttsBaseUrl: 'http://untrusted.example', ttsApiKey: 'ignored' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      audioId: 'preview',
      format: 'wav',
      base64: Buffer.from(wav).toString('base64'),
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8770/synthesize');
    expect(mocks.teaching).not.toHaveBeenCalled();
    expect(mocks.ssrf).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'indic-parler-tts', kind: 'tts' }),
    );
  });

  it.each([429, 503])('surfaces provider HTTP %i without alternate TTS', async (status) => {
    fetchMock.mockResolvedValue(new Response('failure', { status }));
    const response = await POST(request());
    expect(response.status).toBe(status === 429 ? 429 : 500);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: status === 429 ? 'RATE_LIMITED' : 'GENERATION_FAILED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it('still bypasses all normal TTS for an explicit Teaching Voice profile', async () => {
    mocks.teaching.mockResolvedValue({ audio: wav, format: 'wav' });
    const response = await POST(
      request({ teacherVoiceProfileId: 'vcp_test', ttsLanguageCode: 'en' }),
    );
    expect(response.status).toBe(200);
    expect(mocks.teaching).toHaveBeenCalledWith({
      profileId: 'vcp_test',
      ownerId: 'faculty-test',
      text: 'A lesson.',
      language: 'en',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never masks a Teaching Voice failure with Indic Parler', async () => {
    mocks.teaching.mockRejectedValue(new Error('cloning failed'));
    expect((await POST(request({ teacherVoiceProfileId: 'vcp_test' }))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
