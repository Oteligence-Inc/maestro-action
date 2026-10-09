import { normaliseApiUrl, parseInputs } from '../src/inputs';
import { UserError } from '../src/util/errors';

describe('normaliseApiUrl', () => {
  afterEach(() => {
    delete process.env.MAESTRO_ALLOW_CUSTOM_API_URL;
  });

  it('accepts the default oteligence host and strips a trailing slash', () => {
    expect(normaliseApiUrl('https://api.oteligence.com/')).toBe('https://api.oteligence.com');
  });

  it('accepts apex oteligence.com', () => {
    expect(normaliseApiUrl('https://oteligence.com')).toBe('https://oteligence.com');
  });

  it('rejects non-https', () => {
    expect(() => normaliseApiUrl('http://api.oteligence.com')).toThrow(UserError);
  });

  it('rejects a non-oteligence host without the opt-in', () => {
    expect(() => normaliseApiUrl('https://evil.example.com')).toThrow(/oteligence\.com/);
  });

  it('allows a custom host when MAESTRO_ALLOW_CUSTOM_API_URL=1', () => {
    process.env.MAESTRO_ALLOW_CUSTOM_API_URL = '1';
    expect(normaliseApiUrl('https://localhost:8082')).toBe('https://localhost:8082');
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
    delete process.env['INPUT_PROJECT'];
    delete process.env['INPUT_PROJECT-ID'];
  }

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
    process.env['INPUT_ORG-ID'] = '  org_ci ';
    expect(parseInputs().orgId).toBe('org_ci');
    delete process.env['INPUT_ORG-ID'];
    expect(parseInputs().orgId).toBe('');
  });
});
