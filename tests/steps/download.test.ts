import nock from 'nock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
jest.mock('@actions/core');
import * as core from '@actions/core';
import { MaestroApi } from '../../src/api';
import { compactServiceToken, downloadArtifacts } from '../../src/steps/download';
import { UserError } from '../../src/util/errors';

const BASE = 'https://api.oteligence.com';
function client(): MaestroApi {
  const a = new MaestroApi(BASE);
  a.setToken('jwt');
  return a;
}

beforeAll(() => {
  process.env.RUNNER_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-dl-'));
});
afterEach(() => nock.cleanAll());

function bundleZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('opentelemetry-javaagent.jar', Buffer.from('AGENTJAR'));
  zip.addFile('extension.jar', Buffer.from('EXT'));
  return zip.toBuffer();
}

function stubBuild(jobId: string, individualArtifacts: Record<string, unknown>) {
  nock(BASE)
    .get(`/api/job-manager/jobs/${jobId}/download`)
    .reply(200, { status: 'OK', data: { bundleZipUrl: 'https://s3.example.com/bundle.zip', individualArtifacts } });
  nock('https://s3.example.com').get('/bundle.zip').reply(200, bundleZip());
}

it("downloads + extracts the bundle and writes this service's agent config and the collector config", async () => {
  stubBuild('build_1', {
    agentConfigsByService: [
      { serviceName: 'account-service', signedUrl: 'https://s3.example.com/account.config' },
      { serviceName: 'fund-transfer', signedUrl: 'https://s3.example.com/fund-transfer.config' },
    ],
    collectorConfigUrl: 'https://s3.example.com/collector.yaml',
  });
  nock('https://s3.example.com').get('/fund-transfer.config').reply(200, 'FUND_TRANSFER_CONFIG');
  nock('https://s3.example.com').get('/collector.yaml').reply(200, 'COLLECTOR_YAML');

  const paths = await downloadArtifacts(client(), 'build_1', 'fund-transfer');

  expect(fs.existsSync(path.join(paths.extensionDir, 'opentelemetry-javaagent.jar'))).toBe(true);
  expect(fs.existsSync(path.join(paths.extensionDir, 'extension.jar'))).toBe(true);
  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('FUND_TRANSFER_CONFIG');
  expect(fs.readFileSync(paths.collectorConfigPath, 'utf8')).toBe('COLLECTOR_YAML');
  expect(nock.isDone()).toBe(true);
});

it('takes the only config when the build has one, such as a profile with no services', async () => {
  stubBuild('build_3', {
    agentConfigsByService: [{ serviceName: 'all services', signedUrl: 'https://s3.example.com/all.config' }],
  });
  nock('https://s3.example.com').get('/all.config').reply(200, 'SHARED_CONFIG');

  const paths = await downloadArtifacts(client(), 'build_3', 'fund-transfer');

  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('SHARED_CONFIG');
});

it("leaves config-path empty, never another service's config, when this service has none", async () => {
  stubBuild('build_4', {
    agentConfigsByService: [
      { serviceName: 'account-service', signedUrl: 'https://s3.example.com/account.config' },
      { serviceName: 'user-service', signedUrl: 'https://s3.example.com/user.config' },
    ],
    agentConfigUrl: 'https://s3.example.com/legacy.config',
  });

  const paths = await downloadArtifacts(client(), 'build_4', 'fund-transfer');

  expect(paths.configPath).toBe('');
  expect(nock.isDone()).toBe(true);
});

it('matches a registered name to the analysis name by its letters-only form', async () => {
  stubBuild('build_5', {
    agentConfigsByService: [
      { serviceName: 'account-service', signedUrl: 'https://s3.example.com/account.config' },
      { serviceName: 'fund-transfer-service', signedUrl: 'https://s3.example.com/fund-transfer.config' },
    ],
  });
  nock('https://s3.example.com').get('/fund-transfer.config').reply(200, 'FUND_TRANSFER_CONFIG');

  const paths = await downloadArtifacts(client(), 'build_5', 'fundtransfer');

  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('FUND_TRANSFER_CONFIG');
});

it('takes no config when two services reduce to the same letters-only form', async () => {
  stubBuild('build_6', {
    agentConfigsByService: [
      { serviceName: 'payment-service', signedUrl: 'https://s3.example.com/payment.config' },
      { serviceName: 'paymentservice1.0.0', signedUrl: 'https://s3.example.com/payment-glued.config' },
    ],
  });

  const paths = await downloadArtifacts(client(), 'build_6', 'payment');

  expect(paths.configPath).toBe('');
  expect(nock.isDone()).toBe(true);
});

it("finds the config by the analysis's own name when the registered name matches none", async () => {
  stubBuild('build_7', {
    agentConfigsByService: [
      { serviceName: 'account-service', signedUrl: 'https://s3.example.com/account.config' },
      { serviceName: 'transaction-service', signedUrl: 'https://s3.example.com/transaction.config' },
    ],
  });
  nock('https://s3.example.com').get('/transaction.config').reply(200, 'TRANSACTION_CONFIG');

  const paths = await downloadArtifacts(client(), 'build_7', 'transactions', ['transaction-service']);

  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('TRANSACTION_CONFIG');
});

it("prefers the analysis's own name over an exact match on the registered name", async () => {
  stubBuild('build_10', {
    agentConfigsByService: [
      { serviceName: 'payment-service', signedUrl: 'https://s3.example.com/payment.config' },
      { serviceName: 'paymentservice1.0.0', signedUrl: 'https://s3.example.com/payment-glued.config' },
    ],
  });
  nock('https://s3.example.com').get('/payment-glued.config').reply(200, 'GLUED_CONFIG');

  const paths = await downloadArtifacts(client(), 'build_10', 'payment-service', ['paymentservice1.0.0']);

  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('GLUED_CONFIG');
});

it('takes the exact registered name when another service shares its letters-only form', async () => {
  stubBuild('build_8', {
    agentConfigsByService: [
      { serviceName: 'paymentservice1.0.0', signedUrl: 'https://s3.example.com/payment-glued.config' },
      { serviceName: 'payment-service', signedUrl: 'https://s3.example.com/payment.config' },
    ],
  });
  nock('https://s3.example.com').get('/payment.config').reply(200, 'PAYMENT_CONFIG');

  const paths = await downloadArtifacts(client(), 'build_8', 'payment-service');

  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('PAYMENT_CONFIG');
});

it("never takes a lone config that belongs to another service, and warns", async () => {
  (core.warning as jest.Mock).mockClear();
  stubBuild('build_9', {
    agentConfigsByService: [{ serviceName: 'account-service', signedUrl: 'https://s3.example.com/account.config' }],
  });

  const paths = await downloadArtifacts(client(), 'build_9', 'user-service');

  expect(paths.configPath).toBe('');
  expect(nock.isDone()).toBe(true);
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('No single javaagent.config for service "user-service"'));
});

it.each([
  ['paymentservice1.0.0', 'payment'],
  ['payment-service', 'payment'],
  ['orders-api', 'orders'],
  ['service', 'service'],
  ['1.0.0', null],
])('compactServiceToken(%s) is %s', (name, token) => {
  expect(compactServiceToken(name)).toBe(token);
});

it('throws when the build returned no bundle URL', async () => {
  nock(BASE).get('/api/job-manager/jobs/build_2/download').reply(200, { data: { individualArtifacts: {} } });
  await expect(downloadArtifacts(client(), 'build_2', 'fund-transfer')).rejects.toBeInstanceOf(UserError);
});
