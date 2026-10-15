import { spawnSync } from 'child_process';
import * as path from 'path';

// The committed bundle GitHub runs as the post step; ci.yml fails when it is stale.
const bundle = path.join(__dirname, '..', 'dist', 'post', 'index.js');

function runPost(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(INPUT_|STATE_|GITHUB_)/.test(k)));
  return spawnSync(process.execPath, [bundle], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 20000 });
}

it('does nothing, and succeeds, when the main step left no run open', () => {
  const r = runPost({});
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

it('never runs the pipeline: with a run open and no inputs it warns and succeeds', () => {
  const r = runPost({ STATE_deployRunProjectUid: 'proj_1' });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('::warning::Maestro: could not report the deploy run as cancelled');
  expect(r.stdout).not.toContain('::error::');
});
