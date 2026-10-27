import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_FLAG = 'NEXT_PUBLIC_FEATURE_COURSE_NARRATION_SWITCHING';
const SERVER_FLAG = 'OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING';
const EXPERIMENTAL_FLAG = 'OPENMAIC_ENABLE_EXPERIMENTAL_COURSE_NARRATION';
const original = {
  public: process.env[PUBLIC_FLAG],
  server: process.env[SERVER_FLAG],
  experimental: process.env[EXPERIMENTAL_FLAG],
};

async function flags() {
  vi.resetModules();
  return import('@/lib/config/feature-flags');
}

afterEach(() => {
  for (const [key, value] of [
    [PUBLIC_FLAG, original.public],
    [SERVER_FLAG, original.server],
    [EXPERIMENTAL_FLAG, original.experimental],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe('course narration feature gates', () => {
  it('keeps the client, server, and experimental permissions disabled by default', async () => {
    delete process.env[PUBLIC_FLAG];
    delete process.env[SERVER_FLAG];
    delete process.env[EXPERIMENTAL_FLAG];
    const featureFlags = await flags();

    expect(featureFlags.isCourseNarrationSwitchingEnabled()).toBe(false);
    expect(featureFlags.isCourseNarrationServerEnabled()).toBe(false);
    expect(featureFlags.isExperimentalCourseNarrationEnabled()).toBe(false);
  });

  it('requires each deployment permission independently', async () => {
    process.env[PUBLIC_FLAG] = 'true';
    process.env[SERVER_FLAG] = 'true';
    process.env[EXPERIMENTAL_FLAG] = 'true';
    const featureFlags = await flags();

    expect(featureFlags.isCourseNarrationSwitchingEnabled()).toBe(true);
    expect(featureFlags.isCourseNarrationServerEnabled()).toBe(true);
    expect(featureFlags.isExperimentalCourseNarrationEnabled()).toBe(true);
  });
});
