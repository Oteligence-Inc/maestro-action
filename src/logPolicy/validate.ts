import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { COLLECTOR_VALIDATE, RuleSet, fold, matches } from '../ciRules';
import { CollectorConfig, Problem, SourcedSetting } from './extract';

/**
 * The collector the check validates with unless told otherwise: the release every generated collector configuration
 * is validated for, pinned by digest.
 */
export const COLLECTOR_IMAGE =
  'otel/opentelemetry-collector-contrib:0.155.0@sha256:4935caa35e9a4cb387e35732e8fb22b2b5759af8d12e7043357f03837f6e8df5';

/** The most distinct collector configurations one check validates. */
export const COLLECTOR_VALIDATION_MAX = 20;

/** A container image reference the check runs: a name, a tag and a digest, never an option. */
export const IMAGE_SHAPE =
  /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+\/[a-z0-9._/-]+)?(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/**
 * Runs docker with arguments, its output discarded, and gives its exit status: -1 when it could not be started or was
 * stopped at its deadline.
 */
export type Runner = (args: string[], timeoutMs: number) => Promise<{ code: number; timedOut: boolean }>;

/**
 * Runs the docker client at a path with an environment. Nothing it prints is shown: a collector's refusal can quote a
 * value.
 */
export function dockerRunner(docker: string, env: NodeJS.ProcessEnv): Runner {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      let timedOut = false;
      const child = spawn(docker, args, { stdio: 'ignore', env });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: -1, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut || code === null ? -1 : code, timedOut });
      });
    });
}

/** The variables the docker client reads; nothing else of the runner's environment reaches it. */
const DOCKER_KEYS = ['HOME', 'USER', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'SYSTEMROOT'];

/**
 * The first regular, executable docker on a PATH that is not inside the workspace, and the environment it runs with:
 * that PATH without its relative directories or those inside the workspace (docker runs credential helpers from PATH),
 * and the docker client's own variables. Null when there is none.
 */
export function findDocker(workspace: string, pathList = process.env.PATH ?? ''): { docker: string; env: NodeJS.ProcessEnv } | null {
  const root = (() => {
    try {
      return fs.realpathSync(workspace);
    } catch {
      return null;
    }
  })();
  const inside = (p: string): boolean => root !== null && (p === root || p.startsWith(root + path.sep));
  const dirs = pathList.split(path.delimiter).filter((dir) => {
    if (!dir || !path.isAbsolute(dir)) return false;
    try {
      return !inside(fs.realpathSync(dir));
    } catch {
      return true;
    }
  });
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
    try {
      const real = fs.realpathSync(candidate);
      if (inside(real) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      const env: NodeJS.ProcessEnv = { PATH: dirs.join(path.delimiter) };
      for (const k of DOCKER_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
      return { docker: real, env };
    } catch {
      continue;
    }
  }
  return null;
}

/** Whether a rule set holds a rule on a setting name: a version without one has nothing to do with what is written under it. */
export function watches(set: RuleSet, name: string): boolean {
  return set.rules.some((r) => matches(r, fold(name)));
}

export interface Validator {
  image: string;
  run: Runner;
  timeoutMs: number;
  pullMs: number;
}

/** A configuration every collector accepts: a refusal of it means the collector could not be run here. */
const CONTROL_CONFIG =
  'receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n' +
  '    logs:\n      receivers: [otlp]\n      exporters: [debug]\n';

export interface Validated {
  settings: SourcedSetting[];
  problems: Problem[];
}

/**
 * Runs the collector's own validate, check-only, on each whole collector configuration found: in a container with no
 * network, no capabilities and a read-only filesystem, given only the configuration, a fake Kubernetes service account
 * and a stand-in for each environment variable it reads with no default. A refused configuration is a
 * COLLECTOR_VALIDATE setting at its line; what could not be validated is a problem.
 */
export async function validateCollectors(
  collectors: CollectorConfig[],
  v: Validator,
  origin: number,
  results: Map<string, { code: number; why: string }> = new Map(),
): Promise<Validated> {
  const out: Validated = { settings: [], problems: [] };
  if (collectors.length === 0) return out;
  const first = collectors[0];
  const notValidated = (why: string): Validated => {
    out.problems.push({ path: first.path, line: first.line, reason: `collector configurations not validated: ${why}` });
    return out;
  };
  const inspect = await v.run(['image', 'inspect', v.image], v.pullMs);
  if (inspect.code !== 0) {
    const pull = await v.run(['pull', v.image], v.pullMs);
    if (pull.code !== 0) return notValidated('the collector image could not be pulled');
  }
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-collector-'));
  } catch {
    return notValidated('no temporary directory');
  }
  try {
    const cfg = path.join(dir, 'cfg');
    const account = path.join(dir, 'serviceaccount');
    try {
      fs.mkdirSync(cfg, { mode: 0o700 });
      fs.mkdirSync(account, { mode: 0o700 });
      fs.writeFileSync(path.join(account, 'token'), 'validate-only', { mode: 0o600 });
      fs.writeFileSync(path.join(account, 'namespace'), 'default', { mode: 0o600 });
    } catch {
      return notValidated('no temporary directory');
    }
    const control = await validateOne(v, cfg, account, CONTROL_CONFIG, [], []);
    if (control.code !== 0) {
      return notValidated(control.why || `the collector refused a configuration every collector accepts (docker exited ${control.code})`);
    }
    let capped = false;
    const here = new Set<string>();
    for (const c of collectors) {
      if (c.skip) {
        out.problems.push({ path: c.path, line: c.line, reason: `collector configuration not validated: ${c.skip}` });
        continue;
      }
      const key = crypto.createHash('sha256').update(`${v.image}\0${c.text}\0${c.env.join(',')}\0${c.dirs.join(',')}`).digest('hex');
      let r = results.get(key);
      if (!here.has(key)) {
        if (here.size >= COLLECTOR_VALIDATION_MAX) {
          if (!capped) {
            capped = true;
            out.problems.push({
              path: c.path,
              line: c.line,
              reason: `more than ${COLLECTOR_VALIDATION_MAX} collector configurations, the rest not validated`,
            });
          }
          continue;
        }
        here.add(key);
      }
      if (!r) {
        r = await validateOne(v, cfg, account, c.text, c.env, c.dirs);
        results.set(key, r);
      }
      if (r.why) out.problems.push({ path: c.path, line: c.line, reason: `collector configuration not validated: ${r.why}` });
      else if (r.code === 1) out.settings.push({ name: COLLECTOR_VALIDATE, value: '', path: c.path, line: c.line, origin: origin++ });
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the collector's validate on one configuration: its exit status, or why it could not run. */
async function validateOne(
  v: Validator,
  cfg: string,
  account: string,
  text: string,
  env: string[],
  dirs: string[],
): Promise<{ code: number; why: string }> {
  try {
    fs.writeFileSync(path.join(cfg, 'config.yaml'), text, { mode: 0o600 });
  } catch {
    return { code: -1, why: 'it could not be written to a temporary file' };
  }
  const container = `maestro-validate-${crypto.randomBytes(8).toString('hex')}`;
  const args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '512m', '--name', container];
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  args.push('-v', `${cfg}:/cfg:ro`, '-v', `${account}:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
    '-e', 'KUBERNETES_SERVICE_HOST=127.0.0.1', '-e', 'KUBERNETES_SERVICE_PORT=6443');
  for (const e of env) args.push('-e', `${e}=validate-only`);
  for (const d of dirs) args.push('--tmpfs', d);
  args.push(v.image, 'validate', '--config=/cfg/config.yaml');
  const r = await v.run(args, v.timeoutMs);
  if (r.timedOut) {
    await v.run(['rm', '-f', container], 30_000);
    return { code: -1, why: `the collector did not finish in ${Math.round(v.timeoutMs / 1000)}s` };
  }
  if (r.code < 0) return { code: -1, why: 'docker could not be run' };
  if (r.code !== 0 && r.code !== 1) return { code: r.code, why: `docker exited ${r.code}` };
  return { code: r.code, why: '' };
}
