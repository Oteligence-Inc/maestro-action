import nock from 'nock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
jest.mock('@actions/core');
import { MaestroApi } from '../../src/api';
import { downloadArtifacts } from '../../src/steps/download';
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

it('downloads + extracts the bundle and writes the agent/collector configs', async () => {
  const zip = new AdmZip();
  zip.addFile('opentelemetry-javaagent.jar', Buffer.from('AGENTJAR'));
  zip.addFile('extension.jar', Buffer.from('EXT'));
  const zipBuf = zip.toBuffer();

  nock(BASE).get('/api/job-manager/jobs/build_1/download').reply(200, {
    status: 'OK',
    data: {
      bundleZipUrl: 'https://s3.example.com/bundle.zip',
      individualArtifacts: {
        agentConfigUrl: 'https://s3.example.com/agent.config',
        collectorConfigUrl: 'https://s3.example.com/collector.yaml',
      },
    },
  });
  nock('https://s3.example.com').get('/bundle.zip').reply(200, zipBuf);
  nock('https://s3.example.com').get('/agent.config').reply(200, 'OTEL_AGENT_CONFIG');
  nock('https://s3.example.com').get('/collector.yaml').reply(200, 'COLLECTOR_YAML');

  const paths = await downloadArtifacts(client(), 'build_1');

  expect(fs.existsSync(path.join(paths.extensionDir, 'opentelemetry-javaagent.jar'))).toBe(true);
  expect(fs.existsSync(path.join(paths.extensionDir, 'extension.jar'))).toBe(true);
  expect(fs.readFileSync(paths.configPath, 'utf8')).toBe('OTEL_AGENT_CONFIG');
  expect(fs.readFileSync(paths.collectorConfigPath, 'utf8')).toBe('COLLECTOR_YAML');
});

it('throws when the build returned no bundle URL', async () => {
  nock(BASE).get('/api/job-manager/jobs/build_2/download').reply(200, { data: { individualArtifacts: {} } });
  await expect(downloadArtifacts(client(), 'build_2')).rejects.toBeInstanceOf(UserError);
});
