import { describe, expect, test } from 'vitest';

import { generateWidgetContent } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';

const baseOutline: SceneOutline = {
  id: 'simulation-scene',
  type: 'interactive',
  title: 'Projectile Motion',
  description: 'Explore how launch angle changes a projectile path.',
  keyPoints: ['Adjust angle', 'Run the simulation', 'Observe the path'],
  order: 1,
  widgetType: 'simulation',
  widgetOutline: {
    concept: 'projectile_motion',
    keyVariables: ['angle', 'velocity'],
  },
};

describe('simulation widget HTML extraction', () => {
  test('accepts normal complete HTML', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE html>
<html>
<body>Simulation</body>
</html>`);

    expect(content?.html).toContain('Simulation');
    expect(content?.widgetType).toBe('simulation');
  });

  test('accepts complete HTML without a doctype', async () => {
    const content = await generateSimulationWidget(`<html>
<body>Simulation</body>
</html>`);

    expect(content?.html).toContain('Simulation');
  });

  test('accepts fenced HTML and removes the Markdown fence', async () => {
    const content = await generateSimulationWidget(`\`\`\`html
<!DOCTYPE html>
<html>
<body>Simulation</body>
</html>
\`\`\``);

    expect(content?.html).toContain('Simulation');
    expect(content?.html).not.toContain('```');
  });

  test('extracts HTML after leading prose', async () => {
    const content = await generateSimulationWidget(`Here is the simulation:

<!DOCTYPE html>
<html>
<body>Simulation</body>
</html>`);

    expect(content?.html.trim().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(content?.html).toContain('Simulation');
  });

  test('extracts HTML before trailing prose', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE html>
<html>
<body>Simulation</body>
</html>

Generated successfully.`);

    expect(content?.html).toContain('Simulation');
    expect(content?.html).not.toContain('Generated successfully.');
  });

  test('accepts case variations in document tags', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE HTML>
<HTML>
<BODY>Simulation</BODY>
</HTML>`);

    expect(content?.html).toContain('<BODY>Simulation</BODY>');
  });

  test('accepts an explicit JSON-wrapped HTML payload', async () => {
    const response = JSON.stringify({
      html: '<!DOCTYPE html><html><body>Simulation</body></html>',
    });

    const content = await generateSimulationWidget(response);

    expect(content?.html).toContain('Simulation');
  });

  test('rejects non-HTML prose safely', async () => {
    const content = await generateSimulationWidget('I was unable to generate the simulation.');

    expect(content).toBeNull();
  });

  test('rejects truncated HTML safely', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE html>
<html>
<body>
<script>
function run() {`);

    expect(content).toBeNull();
  });

  test('repairs malformed simulation HTML once before validation', async () => {
    const calls: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      calls.push(user);
      return calls.length === 1
        ? `<!DOCTYPE html>
<html>
<body>
<main>These fundamental principles provide a powerful framework.
<script>
function start() {`
        : `<!DOCTYPE html>
<html>
<body>
  <script type="application/json" id="widget-config">{"type":"simulation","concept":"framework","variables":[]}</script>
  <main>These fundamental principles provide a powerful framework.</main>
</body>
</html>`;
    };

    const content = await generateWidgetContent(baseOutline, aiCall);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Repair the malformed simulation below');
    expect(content?.html).toContain('powerful framework');
    expect(content?.widgetConfig).toMatchObject({ type: 'simulation', concept: 'framework' });
  });

  test('normalizes a missing widget config type from the requested widget type', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE html>
<html>
<body>
  <script type="application/json" id="widget-config">
    {"concept":"projectile_motion","description":"Projectile motion simulation","variables":[]}
  </script>
  <main>Simulation</main>
</body>
</html>`);

    expect(content?.widgetConfig).toMatchObject({
      type: 'simulation',
      concept: 'projectile_motion',
    });
  });

  test('rejects an explicit conflicting widget config type', async () => {
    const content = await generateSimulationWidget(`<!DOCTYPE html>
<html>
<body>
  <script type="application/json" id="widget-config">
    {"type":"diagram","concept":"projectile_motion","description":"Projectile motion simulation","variables":[]}
  </script>
  <main>Simulation</main>
</body>
</html>`);

    expect(content).toBeNull();
  });
});

async function generateSimulationWidget(response: string) {
  const aiCall: AICallFn = async () => response;
  return generateWidgetContent(baseOutline, aiCall);
}
