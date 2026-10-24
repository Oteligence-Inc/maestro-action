import * as crypto from 'crypto';
import { normaliseApiUrl, parseInputs, parseSigningKey } from '../src/inputs';
import { UserError } from '../src/util/errors';

describe('normaliseApiUrl', () => {
  it('accepts an oteligence host and strips a trailing slash', () => {
    expect(normaliseApiUrl('https://api.oteligence.com/')).toBe('https://api.oteligence.com');
  });

  it('accepts apex oteligence.com', () => {
    expect(normaliseApiUrl('https://oteligence.com')).toBe('https://oteligence.com');
  });

  it('rejects non-https', () => {
    expect(() => normaliseApiUrl('http://api.oteligence.com')).toThrow(UserError);
  });

  it('rejects a non-oteligence host that no trusted-api-host names, and says which input to set', () => {
    expect(() => normaliseApiUrl('https://evil.example.com')).toThrow(/oteligence\.com.*trusted-api-host/);
  });

  it('accepts the host trusted-api-host names, case and port aside', () => {
    expect(normaliseApiUrl('https://Maestro.Bank.internal:8443/', 'maestro.bank.INTERNAL')).toBe(
      'https://Maestro.Bank.internal:8443',
    );
    expect(normaliseApiUrl('https://localhost:8443', ' localhost ')).toBe('https://localhost:8443');
  });

  it('accepts a trusted host in any form that names the same host, as URL parsing writes it', () => {
    expect(normaliseApiUrl('https://bücher.example', 'Bücher.example')).toBe('https://bücher.example');
    expect(normaliseApiUrl('https://[fd00::1]:8443', '[fd00:0:0::1]')).toBe('https://[fd00::1]:8443');
  });

  it('refuses a host that only starts or ends like the trusted one', () => {
    const lookalikes = [
      'https://evil-maestro.bank.internal',
      'https://x.maestro.bank.internal',
      'https://maestro.bank.internalx',
    ];
    for (const url of lookalikes) {
      expect(() => normaliseApiUrl(url, 'maestro.bank.internal')).toThrow(/not the trusted-api-host/);
    }
  });

  it('refuses a host that only ends in oteligence.com without the dot', () => {
    expect(() => normaliseApiUrl('https://nototeligence.com')).toThrow(/trusted-api-host/);
  });

  it('never echoes a refused trusted-api-host, which may carry a password', () => {
    expect(() => normaliseApiUrl('https://maestro.bank.internal', 'https://ci:s3cret@maestro.bank.internal')).toThrow(
      /^(?!.*s3cret).*hostname only/,
    );
  });

  it('still refuses http:// on the trusted host', () => {
    expect(() => normaliseApiUrl('http://maestro.bank.internal', 'maestro.bank.internal')).toThrow(/https/);
  });

  it('refuses a host other than the trusted one, an oteligence host included', () => {
    expect(() => normaliseApiUrl('https://evil.example.com', 'maestro.bank.internal')).toThrow(
      /not the trusted-api-host "maestro\.bank\.internal"/,
    );
    expect(() => normaliseApiUrl('https://maestro.bank.internal.evil.example', 'maestro.bank.internal')).toThrow(
      UserError,
    );
    expect(() => normaliseApiUrl('https://prod.api.oteligence.com', 'maestro.bank.internal')).toThrow(UserError);
  });

  it.each([
    'https://maestro.bank.internal',
    'maestro.bank.internal:8443',
    '*.bank.internal',
    'maestro.bank.internal/api',
    'user@maestro.bank.internal',
    'maestro.bank.internal?x',
    'fd00::1',
  ])('refuses a trusted-api-host that is not a bare hostname: %s', (trusted) => {
    expect(() => normaliseApiUrl('https://maestro.bank.internal', trusted)).toThrow(
      /trusted-api-host must be a hostname/,
    );
  });

  it('no longer reads the retired MAESTRO_ALLOW_CUSTOM_API_URL switch', () => {
    process.env.MAESTRO_ALLOW_CUSTOM_API_URL = '1';
    try {
      expect(() => normaliseApiUrl('https://localhost:8082')).toThrow(/trusted-api-host/);
    } finally {
      delete process.env.MAESTRO_ALLOW_CUSTOM_API_URL;
    }
  });

  it('rejects a host that merely contains oteligence.com as a substring', () => {
    expect(() => normaliseApiUrl('https://oteligence.com.evil.example')).toThrow(UserError);
  });
});

describe('parseInputs — project / project-id', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });
  // @actions/core reads INPUT_<UPPER-NAME>. Set the always-required ones, vary project/project-id.
  function seedRequired() {
    process.env['INPUT_API-KEY'] = 'k';
    process.env['INPUT_SERVICE'] = 'svc';
    process.env['INPUT_ENVIRONMENT'] = 'dev';
    process.env['INPUT_JARS'] = 'target/x.jar';
    process.env['INPUT_API-URL'] = 'https://prod.api.oteligence.com';
    delete process.env['INPUT_PROJECT'];
    delete process.env['INPUT_PROJECT-ID'];
  }

  it('requires api-url: there is no default API', () => {
    seedRequired();
    process.env['INPUT_PROJECT-ID'] = 'proj_1';
    delete process.env['INPUT_API-URL'];
    expect(() => parseInputs()).toThrow(/api-url/);
    process.env['INPUT_API-URL'] = 'https://develop.api.oteligence.com/';
    expect(parseInputs().apiUrl).toBe('https://develop.api.oteligence.com');
  });

  it('passes trusted-api-host through to the api-url check', () => {
    seedRequired();
    process.env['INPUT_PROJECT-ID'] = 'proj_1';
    process.env['INPUT_API-URL'] = 'https://maestro.bank.internal/';
    delete process.env['INPUT_TRUSTED-API-HOST'];
    expect(() => parseInputs()).toThrow(/trusted-api-host/);
    process.env['INPUT_TRUSTED-API-HOST'] = 'maestro.bank.internal';
    expect(parseInputs().apiUrl).toBe('https://maestro.bank.internal');
  });

  it('throws when neither project nor project-id is provided', () => {
    seedRequired();
    expect(() => parseInputs()).toThrow(/project.*project-id/i);
  });

  it('accepts project-id alone (name empty)', () => {
    seedRequired();
    process.env['INPUT_PROJECT-ID'] = 'b6a6c970c2c54aa6a7816';
    const i = parseInputs();
    expect(i.projectId).toBe('b6a6c970c2c54aa6a7816');
    expect(i.project).toBe('');
  });

  it('accepts project name alone (id empty)', () => {
    seedRequired();
    process.env['INPUT_PROJECT'] = 'otel-3July';
    const i = parseInputs();
    expect(i.project).toBe('otel-3July');
    expect(i.projectId).toBe('');
  });

  it('skip-generate-on-inactive defaults to false', () => {
    seedRequired();
    process.env['INPUT_PROJECT'] = 'p';
    delete process.env['INPUT_SKIP-GENERATE-ON-INACTIVE'];
    expect(parseInputs().skipGenerateOnInactive).toBe(false);
  });

  it('skip-generate-on-inactive parses true (case-insensitive)', () => {
    seedRequired();
    process.env['INPUT_PROJECT'] = 'p';
    process.env['INPUT_SKIP-GENERATE-ON-INACTIVE'] = 'TRUE';
    expect(parseInputs().skipGenerateOnInactive).toBe(true);
  });

  it('skip-on-removed-service defaults to false', () => {
    seedRequired();
    process.env['INPUT_PROJECT'] = 'p';
    delete process.env['INPUT_SKIP-ON-REMOVED-SERVICE'];
    expect(parseInputs().skipOnRemovedService).toBe(false);
  });

  it('skip-on-removed-service parses true (case-insensitive)', () => {
    seedRequired();
    process.env['INPUT_PROJECT'] = 'p';
    process.env['INPUT_SKIP-ON-REMOVED-SERVICE'] = 'True';
    expect(parseInputs().skipOnRemovedService).toBe(true);
  });
});

describe('parseInputs — org-id', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('trims org-id and leaves it empty when unset', () => {
    process.env['INPUT_API-KEY'] = 'k';
    process.env['INPUT_PROJECT-ID'] = 'proj_1';
    process.env['INPUT_SERVICE'] = 'svc';
    process.env['INPUT_ENVIRONMENT'] = 'dev';
    process.env['INPUT_JARS'] = 'target/x.jar';
    process.env['INPUT_API-URL'] = 'https://prod.api.oteligence.com';
    process.env['INPUT_ORG-ID'] = '  org_ci ';
    expect(parseInputs().orgId).toBe('org_ci');
    delete process.env['INPUT_ORG-ID'];
    expect(parseInputs().orgId).toBe('');
  });
});

describe('signing-public-key', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });
  const pair = crypto.generateKeyPairSync('ed25519');
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  it('is null when unset or blank', () => {
    expect(parseSigningKey('')).toBeNull();
    expect(parseSigningKey('  \n')).toBeNull();
  });

  it('reads a PEM and the base64 of the SubjectPublicKeyInfo DER as the same key', () => {
    const fromPem = parseSigningKey(pem);
    const fromDer = parseSigningKey(`  ${der.slice(0, 20)}\n${der.slice(20)}  `);
    for (const key of [fromPem, fromDer]) {
      expect(key?.export({ type: 'spki', format: 'der' }).equals(pair.publicKey.export({ type: 'spki', format: 'der' })))
        .toBe(true);
    }
  });

  it('refuses a private key rather than reducing it to its public half', () => {
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parseSigningKey(privatePem)).toThrow(/holds a private key.*replace the signing key/);
  });

  it('refuses a key of another type, and text that is no key', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => parseSigningKey(rsa)).toThrow(/must be an Ed25519 key, not rsa/);
    for (const junk of ['not a key!', 'c2VjcmV0', '-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----']) {
      expect(() => parseSigningKey(junk)).toThrow(/is not a public key/);
    }
  });

  it('reaches the parsed inputs', () => {
    process.env['INPUT_API-KEY'] = 'k';
    process.env['INPUT_PROJECT-ID'] = 'proj_1';
    process.env['INPUT_SERVICE'] = 'svc';
    process.env['INPUT_ENVIRONMENT'] = 'dev';
    process.env['INPUT_JARS'] = 'target/x.jar';
    process.env['INPUT_API-URL'] = 'https://prod.api.oteligence.com';
    delete process.env['INPUT_SIGNING-PUBLIC-KEY'];
    expect(parseInputs().signingKey).toBeNull();
    process.env['INPUT_SIGNING-PUBLIC-KEY'] = pem;
    expect(parseInputs().signingKey?.asymmetricKeyType).toBe('ed25519');
  });
});
