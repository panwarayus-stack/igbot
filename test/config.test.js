import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/lib/config.js';
import { ConfigError } from '../src/lib/errors.js';

const SECRET = 'x'.repeat(40);
const base = { IG_USERNAME: 'example_user', IG_PASSWORD: 'pw', SESSION_SECRET: SECRET };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const cfg = parseConfig(base, { projectRoot: '/proj' });
    expect(cfg.prefix).toBe('!');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.pollIntervalMs).toBe(10000);
    expect(cfg.loginCooldownMinutes).toBe(60);
    expect(cfg.dataDir).toBe('/proj/data');
    expect(cfg.sessionFile).toBe('/proj/data/session.enc');
    expect(cfg.authStateFile).toBe('/proj/data/auth-state.json');
  });

  it('treats empty strings as unset', () => {
    const cfg = parseConfig({ ...base, BOT_PREFIX: '', POLL_INTERVAL_MS: '' });
    expect(cfg.prefix).toBe('!');
    expect(cfg.pollIntervalMs).toBe(10000);
  });

  it('keeps passwords untrimmed', () => {
    expect(parseConfig({ ...base, IG_PASSWORD: ' pw with spaces ' }).password).toBe(' pw with spaces ');
  });

  it('allows an empty password (a saved session may be used instead)', () => {
    expect(parseConfig({ ...base, IG_PASSWORD: '' }).password).toBe('');
    expect(parseConfig({ ...base, IG_PASSWORD: undefined }).password).toBe('');
  });

  it('requires IG_USERNAME and SESSION_SECRET, naming them without echoing values', () => {
    expect(() => parseConfig({ ...base, IG_USERNAME: '' })).toThrow(ConfigError);
    try {
      parseConfig({ SESSION_SECRET: 'short' });
    } catch (err) {
      expect(err.message).toMatch(/IG_USERNAME/);
      expect(err.message).toMatch(/SESSION_SECRET/);
      expect(err.message).not.toMatch(/short/);
    }
  });

  it('rejects a short session secret', () => {
    expect(() => parseConfig({ ...base, SESSION_SECRET: 'too-short' })).toThrow(/at least 32/);
  });

  it('validates numeric and enum values', () => {
    expect(() => parseConfig({ ...base, POLL_INTERVAL_MS: '100' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() => parseConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => parseConfig({ ...base, BOT_PREFIX: 'toolongprefix' })).toThrow(/BOT_PREFIX/);
  });
});
