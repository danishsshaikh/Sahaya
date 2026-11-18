import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({
  getSessionUser: mocks.getSessionUser,
  toPublicAuthUser: (user: unknown) => user,
}));

import { GET } from '@/app/api/auth/me/route';

describe('GET /api/auth/me route classification', () => {
  beforeEach(() => mocks.getSessionUser.mockReset());

  it('returns 401 rather than 404 when the session is absent', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/auth/me'));
    expect(response.status).toBe(401);
  });

  it('returns the authenticated user when the session resolves', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'owner-1', role: 'faculty' });
    const response = await GET(new NextRequest('http://localhost/api/auth/me'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      user: { id: 'owner-1' },
    });
  });
});
