import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Narration Voice modal integration', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'components/edit/NarrationVoiceDialog.tsx'),
    'utf8',
  );

  it('uses the owner-validated narration route for both hydration and provider bootstrap', () => {
    expect(source).toContain("method: 'PUT'");
    expect(source).toContain('/api/course-narration?stageId=');
    expect(source).toContain('body.narration.profile ?? null');
  });

  it('does not issue the independently gated duplicate voice-profile request', () => {
    expect(source).not.toContain('/api/voice-cloning/profile');
  });

  it('keeps explicit loading, error, and no-narration states', () => {
    expect(source).toContain('Loading narration providers');
    expect(source).toContain('This classroom has no narration segments');
    expect(source).toContain('role="alert"');
  });
});
