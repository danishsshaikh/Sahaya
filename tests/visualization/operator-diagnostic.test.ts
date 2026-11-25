import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('loads the model diagnostic through Node with the import export condition', () => {
  // With the base URL missing, the CLI takes its normal configuration-error
  // path without contacting an inference or documentation endpoint.
  const result = spawnSync(
    process.execPath,
    ['--conditions=import', '--import', 'tsx', 'scripts/diagnose-manim-model.ts'],
    {
      env: {
        ...process.env,
        CONTEXT7_API_KEY: '',
        LOG_LEVEL: 'error',
        MANIM_MODEL_PRIMARY_MODEL: 'openai:diagnostic-load-fixture',
        MANIM_MODEL_PRIMARY_BASE_URL: '',
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  expect(JSON.parse(result.stderr)).toMatchObject({
    event: 'manim-model-diagnostic',
    submittedPython: false,
    failureCode: 'VISUALIZATION_MODEL_UNAVAILABLE',
  });
});

it(
  'uses the selected publisher interpreter, repairs syntax, captures privately, and verifies a preview',
  { timeout: 10_000 },
  () => {
    const folder = mkdtempSync(join(tmpdir(), 'test-manim-diagnostic-'));
    try {
      const docker = join(folder, 'docker');
      const preload = join(folder, 'transport.mjs');
      const good =
        '# sahaya-cues: [{"id":"intro","narration":"Watch the dot."}]\nfrom manim import Dot\nfrom sahaya_timing import CueScene\nclass GeneratedScene(CueScene):\n    def construct(self):\n        with self.cue("intro"):\n            self.add(Dot())\n';
      const bad = good.replace('self.add(Dot())', 'self.add(Dot()');
      const media = '0000ftyp-mock-video';
      const sha256 = createHash('sha256').update(media).digest('hex');
      writeFileSync(
        docker,
        `#!/bin/sh
exec "$SAHAYA_FIXTURE_NODE" -e '
const fs = require("fs");
const args = process.argv.slice(1);
if (JSON.stringify(args.slice(0, 9)) !== JSON.stringify(["exec","-i","--user","1000:1000","sahaya-manim-hpc","python","-I","-B","-c"])) process.exit(2);
if (!args[9].includes("preflight(json.load(sys.stdin))") || args[10] !== "/opt/sahaya-manim") process.exit(3);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
console.log(JSON.stringify({version: "0.22.1", pythonVersion: "3.14.10", findings: [], source: input.source, ...(input.source.endsWith("self.add(Dot()\\n") && {issue:{code:"syntax",line:7}})}));
' -- "$@"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        preload,
        `
import assert from 'node:assert/strict';
let turn = 0;
const bad = ${JSON.stringify(bad)};
const good = ${JSON.stringify(good)};
const media = ${JSON.stringify(media)};
let owner;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    assert.match(body.messages.at(-1).content, /equal-amplitude sine waves/);
    if (turn === 1) {
      assert.match(body.messages.at(-1).content, /"line":7/);
      assert.equal(JSON.parse(body.messages.at(-1).content).priorSourceAndCues.source, bad);
    }
    return Response.json({
      id: 'fixture', object:'chat.completion', created: 1, model: 'operator-fixture',
      choices: [{index:0, finish_reason: 'stop', message: {role:'assistant', content: turn++ === 0 ? bad : good}}]
    });
  }
  if (url.endsWith('/ready')) return Response.json({
    protocol:4, maxDuration:90, manimVersion:'0.22.1', isolation:'verified', secureExecution:true,
    rendererReady:true, backend:'bubblewrap', sandboxImage:'sha256:'+'a'.repeat(64)
  });
  if (url.endsWith('/jobs')) {
    const job = JSON.parse(init.body);
    assert.equal(job.source, good);
    assert.equal(job.publication, 'preview');
    assert.equal(job.quality, 'preview');
    owner = new Headers(init.headers).get('X-Manim-Owner');
    return Response.json({status:'completed', artifact:{
      artifactId:'b'.repeat(64), quality:'preview', verification:{media:'decoded'},
      bytes:media.length, sha256:${JSON.stringify(sha256)}
    }});
  }
  if (url.endsWith('/video.mp4')) {
    assert.ok(owner);
    assert.equal(new Headers(init.headers).get('X-Manim-Owner'), owner);
    return new Response(media, {headers:{'Content-Length':String(media.length)}});
  }
  throw new Error('Unexpected fixture request');
};
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--conditions=import',
          '--import',
          'tsx',
          '--import',
          pathToFileURL(preload).href,
          'scripts/diagnose-manim-model.ts',
          '--task',
          'wave-interference',
          '--publisher-container',
          'sahaya-manim-hpc',
          '--preview',
          '--capture',
        ],
        {
          env: {
            ...process.env,
            TMPDIR: folder,
            PATH: folder + delimiter + process.env.PATH,
            SAHAYA_FIXTURE_NODE: process.execPath,
            CONTEXT7_API_KEY: '',
            LOG_LEVEL: 'error',
            MANIM_AGENT_STREAM: 'false',
            MANIM_AGENT_MODEL_CALLS: '3',
            OPENMAIC_ENABLE_MANIM: 'true',
            MANIM_RENDERER_URL: 'http://publisher.example',
            MANIM_RENDERER_TOKEN: 'test-operator-token-at-least-24',
            MANIM_MODEL_PRIMARY_MODEL: 'openai:operator-fixture',
            MANIM_MODEL_PRIMARY_BASE_URL: 'http://model.example/v1',
            MANIM_MODEL_PRIMARY_LOCAL: 'true',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('self.add(Dot())');
      const records = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'manim-model-static-validation',
          pythonVersion: '3.14.10',
          issueCode: 'syntax',
          issueLine: 7,
        }),
      );
      expect(records.at(-1)).toMatchObject({
        task: 'wave-interference',
        validPython: true,
        pythonVersion: '3.14.10',
        playableArtifact: true,
      });
      const capture = records[0].directory;
      expect(statSync(capture).mode & 0o777).toBe(0o700);
      expect(statSync(join(capture, 'turn-1.response.json')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(capture, 'turn-1.py'), 'utf8')).toBe(bad);
      expect(readFileSync(join(capture, 'turn-2.py'), 'utf8')).toBe(good);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
