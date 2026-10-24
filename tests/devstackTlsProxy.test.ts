import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The local TLS front the README's devstack and private-cloud runs use. It listens on fixed ports 8443 and 9443.
const SCRIPT = path.join(__dirname, '..', 'scripts', 'devstack-tls-proxy.mjs');

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function listening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

describe('devstack-tls-proxy fronting a private-cloud gateway', () => {
  let dir: string;
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: ChildProcess;
  let banner = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-proxy-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    proxy = spawn(process.execPath, [SCRIPT, path.join(dir, 'cert.pem'), path.join(dir, 'key.pem')], {
      env: { ...process.env, TLS_PROXY_GATEWAY: `127.0.0.1:${upstreamPort}`, TLS_PROXY_S3: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      proxy.stdout?.on('data', (d) => {
        banner += String(d);
        if (banner.includes('8443')) resolve();
      });
      proxy.on('exit', (code) => reject(new Error(`proxy exited ${code}`)));
    });
  });

  afterAll(async () => {
    proxy?.kill();
    await new Promise<void>((r) => upstream.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forwards :8443 to TLS_PROXY_GATEWAY with the path and that host', async () => {
    const res = await get('https://localhost:8443/api/auth/cli/token?orgId=o1');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: '/api/auth/cli/token?orgId=o1', host: `127.0.0.1:${upstreamPort}` });
  });

  it('leaves :9443 closed when TLS_PROXY_S3 is none', async () => {
    expect(await listening(9443)).toBe(false);
    expect(await listening(8443)).toBe(true);
  });

  it('listens on loopback only, so no other host is relayed to the gateway', async () => {
    expect(banner).toContain('(127.0.0.1)');
    const external = Object.values(os.networkInterfaces()).flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal);
    if (external) expect(await listening(8443, external.address)).toBe(false);
  });
});

describe('devstack-tls-proxy flipping a byte on request, for the refusal test', () => {
  let dir: string;
  let upstream: http.Server;
  let proxy: ChildProcess;
  let output = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-proxy-tamper-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '6' });
      res.end('ABCDEF');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as net.AddressInfo).port;
    proxy = spawn(process.execPath, [SCRIPT, path.join(dir, 'cert.pem'), path.join(dir, 'key.pem')], {
      env: { ...process.env, TLS_PROXY_GATEWAY: `127.0.0.1:${port}`, TLS_PROXY_S3: `127.0.0.1:${port}`,
        TLS_PROXY_TAMPER: 'collector-config.yaml' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      proxy.stdout?.on('data', (d) => {
        output += String(d);
        if (output.includes('9443')) resolve();
      });
      proxy.on('exit', (code) => reject(new Error(`proxy exited ${code}`)));
    });
  });

  afterAll(async () => {
    proxy?.kill();
    await new Promise<void>((r) => upstream.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flips the last byte of a matching storage download, logging its path without the signature', async () => {
    const res = await get('https://localhost:9443/bucket/multi-jar/b1/collector-config.yaml?X-Amz-Signature=secret');
    expect(res.body).toBe('ABCDEG');
    for (let i = 0; i < 50 && !output.includes('tampered'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(output).toContain('tampered /bucket/multi-jar/b1/collector-config.yaml');
    expect(output).not.toContain('secret');
  });

  it('passes every other download and the gateway through unchanged', async () => {
    expect((await get('https://localhost:9443/bucket/multi-jar/b1/javaagent.config')).body).toBe('ABCDEF');
    expect((await get('https://localhost:8443/api/job-manager/x/collector-config.yaml')).body).toBe('ABCDEF');
  });
});
