import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CollectorConfig } from '../../src/logPolicy/extract';
import {
  COLLECTOR_IMAGE,
  COLLECTOR_VALIDATION_MAX,
  IMAGE_SHAPE,
  Runner,
  Validator,
  dockerRunner,
  findDocker,
  validateCollectors,
} from '../../src/logPolicy/validate';

/** A docker stand-in: answers each call by its first argument, and validates by what the mounted configuration holds. */
function fake(opts: { inspect?: number; pull?: number; validate?: (text: string) => number; slow?: string } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    if (args[0] === 'image') return { code: opts.inspect ?? 0, timedOut: false };
    if (args[0] === 'pull') return { code: opts.pull ?? 0, timedOut: false };
    if (args[0] === 'rm') return { code: 0, timedOut: false };
    const mount = args[args.indexOf('-v') + 1].replace(/:\/cfg:ro$/, '');
    const text = fs.readFileSync(path.join(mount, 'config.yaml'), 'utf8');
    if (opts.slow && text.includes(opts.slow)) return { code: -1, timedOut: true };
    return { code: (opts.validate ?? (() => 0))(text), timedOut: false };
  };
  return { calls, run, runs: () => calls.filter((c) => c[0] === 'run') };
}

function validator(run: Runner): Validator {
  return { image: COLLECTOR_IMAGE, run, timeoutMs: 60_000, pullMs: 1000 };
}

const config = (p: string, line: number, text: string, extra: Partial<CollectorConfig> = {}): CollectorConfig => ({
  path: p, line, text, env: [], dirs: [], skip: '', ...extra,
});

it('runs nothing with no collector configuration', async () => {
  const f = fake();
  expect(await validateCollectors([], validator(f.run), 0)).toEqual({ settings: [], problems: [] });
  expect(f.calls).toEqual([]);
});

it('writes a setting at a refused configuration only, after a control the collector accepts', async () => {
  const f = fake({ validate: (t) => (t.includes('broken') ? 1 : 0) });
  const got = await validateCollectors([config('a.yaml', 3, 'fine'), config('b.yaml', 7, 'broken')], validator(f.run), 5);
  expect(got).toEqual({ settings: [{ name: 'collector.validate', value: '', path: 'b.yaml', line: 7, origin: 5 }], problems: [] });
  expect(f.runs()).toHaveLength(3);
});

it('locks the container down and passes it only the stand-ins it names', async () => {
  const f = fake();
  process.env.MAESTRO_TOKEN_FOR_TEST = 'secret-token';
  try {
    await validateCollectors([config('a.yaml', 1, 'x', { env: ['DD_API_KEY'] })], validator(f.run), 0);
  } finally {
    delete process.env.MAESTRO_TOKEN_FOR_TEST;
  }
  const args = f.runs()[1].join(' ');
  for (const want of [
    'run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 512m',
    ':/cfg:ro', ':/var/run/secrets/kubernetes.io/serviceaccount:ro',
    `-e KUBERNETES_SERVICE_HOST=127.0.0.1 -e KUBERNETES_SERVICE_PORT=6443 -e DD_API_KEY=validate-only ${COLLECTOR_IMAGE} validate --config=/cfg/config.yaml`,
  ]) {
    expect(args).toContain(want);
  }
  expect(args).not.toContain('secret-token');
});

it('validates nothing when the image cannot be pulled, the control is refused, or docker fails', async () => {
  let f = fake({ inspect: 1, pull: 1, validate: () => 1 });
  let got = await validateCollectors([config('a.yaml', 2, 'broken')], validator(f.run), 0);
  expect(got.settings).toEqual([]);
  expect(got.problems).toEqual([{ path: 'a.yaml', line: 2, reason: 'collector configurations not validated: the collector image could not be pulled' }]);
  expect(f.runs()).toEqual([]);

  f = fake({ inspect: 1, validate: () => 1 });
  got = await validateCollectors([config('a.yaml', 2, 'broken')], validator(f.run), 0);
  expect(f.calls.map((c) => c[0])).toEqual(['image', 'pull', 'run']);
  expect(got.settings).toEqual([]);
  expect(got.problems[0].reason).toContain('every collector accepts');

  f = fake({ validate: (t) => (t.includes('broken') ? 125 : 0) });
  got = await validateCollectors([config('a.yaml', 2, 'broken')], validator(f.run), 0);
  expect(got).toEqual({ settings: [], problems: [{ path: 'a.yaml', line: 2, reason: 'collector configuration not validated: docker exited 125' }] });
});

it('names a skipped configuration, removes a timed-out container, and runs each text once', async () => {
  const f = fake({ slow: 'slow', validate: (t) => (t.includes('broken') ? 1 : 0) });
  const got = await validateCollectors(
    [
      config('t.yaml', 1, 'x', { skip: 'it is in a Helm template' }),
      config('s.yaml', 4, 'slow'),
      config('a.yaml', 2, 'broken'),
      config('b.yaml', 9, 'broken'),
    ],
    validator(f.run),
    0,
  );
  expect(f.runs()).toHaveLength(3);
  expect(f.calls.filter((c) => c[0] === 'rm')).toHaveLength(1);
  expect(got.problems).toEqual([
    { path: 't.yaml', line: 1, reason: 'collector configuration not validated: it is in a Helm template' },
    { path: 's.yaml', line: 4, reason: 'collector configuration not validated: the collector did not finish in 60s' },
  ]);
  expect(got.settings.map((s) => [s.path, s.origin])).toEqual([['a.yaml', 0], ['b.yaml', 1]]);
});

it('shares results across checks of one run, and stops past the cap', async () => {
  const f = fake();
  const results = new Map();
  await validateCollectors([config('a.yaml', 1, 'same')], validator(f.run), 0, results);
  await validateCollectors([config('b.yaml', 1, 'same')], validator(f.run), 0, results);
  expect(f.runs()).toHaveLength(3);

  const g = fake();
  const many = Array.from({ length: COLLECTOR_VALIDATION_MAX + 3 }, (_, i) => config('c.yaml', i + 1, 'x'.repeat(i + 1)));
  const got = await validateCollectors(many, validator(g.run), 0);
  expect(g.runs()).toHaveLength(COLLECTOR_VALIDATION_MAX + 1);
  expect(got.problems).toEqual([{ path: 'c.yaml', line: COLLECTOR_VALIDATION_MAX + 1, reason: `more than ${COLLECTOR_VALIDATION_MAX} collector configurations, the rest not validated` }]);
});

it('takes an image reference and never an option', () => {
  for (const ok of [COLLECTOR_IMAGE, 'otel/opentelemetry-collector-contrib:0.164.0', 'registry.example.com:5000/otel/contrib:1.2']) {
    expect(IMAGE_SHAPE.test(ok)).toBe(true);
  }
  for (const bad of ['', '-v', '--privileged', 'otel/x:1 --privileged', 'Otel/x', 'x:', 'x@sha256:abc']) {
    expect(IMAGE_SHAPE.test(bad)).toBe(false);
  }
});

it('finds no docker inside the workspace', () => {
  const ws = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(ws, 'bin'));
  fs.writeFileSync(path.join(ws, 'bin', 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = path.join(ws, 'bin');
  try {
    expect(findDocker(ws)).toBeNull();
    expect(findDocker(fs.mkdtempSync(path.join(require('os').tmpdir(), 'other-')))?.docker).toBe(fs.realpathSync(path.join(ws, 'bin', 'docker')));
  } finally {
    process.env.PATH = PATH;
  }
});

const docker = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return findDocker('/nonexistent')?.docker ?? null;
  } catch {
    return null;
  }
})();

(process.env.RUN_DOCKER_TESTS === 'true' && docker ? it : it.skip)('accepts and refuses through the real collector', async () => {
  const control = 'receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n';
  const got = await validateCollectors(
    [config('ok.yaml', 1, `${control}      exporters: [debug]\n`), config('undefined.yaml', 4, `${control}      processors: [redaction]\n      exporters: [debug]\n`)],
    { image: COLLECTOR_IMAGE, run: dockerRunner(docker as string, process.env), timeoutMs: 60_000, pullMs: 300_000 },
    0,
  );
  expect(got).toEqual({ settings: [{ name: 'collector.validate', value: '', path: 'undefined.yaml', line: 4, origin: 0 }], problems: [] });
}, 600_000);

it('gives each file_storage directory an empty in-memory directory', async () => {
  const f = fake();
  await validateCollectors([config('a.yaml', 1, 'x', { dirs: ['/var/lib/otelcol/fs'] })], validator(f.run), 0);
  expect(f.runs()[1].join(' ')).toContain(`--tmpfs /var/lib/otelcol/fs ${COLLECTOR_IMAGE}`);
});

it('caps each check on its own while sharing results across a run', async () => {
  const f = fake();
  const results = new Map();
  const many = Array.from({ length: COLLECTOR_VALIDATION_MAX }, (_, i) => config('c.yaml', i + 1, 'x'.repeat(i + 1)));
  await validateCollectors(many, validator(f.run), 0, results);
  const got = await validateCollectors([config('d.yaml', 1, 'other')], validator(f.run), 0, results);
  expect(got.problems).toEqual([]);
});

it("gives docker a PATH without the workspace's own or relative directories, and none of the runner's other variables", () => {
  const os = require('os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  for (const d of [path.join(ws, 'bin'), path.join(outside, 'bin'), path.join(outside, 'dir', 'docker')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ws, 'bin', 'docker'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(outside, 'bin', 'docker'), '#!/bin/sh\n', { mode: 0o755 });
  process.env.INPUT_API_KEY_FOR_TEST = 'never-for-docker';
  try {
    const found = findDocker(ws, [path.join(ws, 'bin'), 'relative/bin', path.join(outside, 'dir'), path.join(outside, 'bin')].join(path.delimiter));
    expect(found?.docker).toBe(fs.realpathSync(path.join(outside, 'bin', 'docker')));
    expect(found?.env.PATH).toBe([path.join(outside, 'dir'), path.join(outside, 'bin')].join(path.delimiter));
    expect(JSON.stringify(found?.env)).not.toContain('never-for-docker');
  } finally {
    delete process.env.INPUT_API_KEY_FOR_TEST;
  }
});
