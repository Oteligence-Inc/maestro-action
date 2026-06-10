import { normaliseApiUrl } from '../src/inputs';
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
