import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiSuccess } from '@/lib/server/api-response';
import { customPythonRequested, getVisualizationCapability } from '@/lib/visualization/renderer';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);
  if (user instanceof Response) return user;
  return apiSuccess({
    ...(await getVisualizationCapability()),
    experimentalPython: customPythonRequested() ? 'isolation-unavailable' : 'disabled',
  });
}
