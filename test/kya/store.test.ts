import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../../src/crypto/ed25519.js';
import { runAgentAdd, runInit } from '../../src/cli/kya-commands.js';
import { CredentialError } from '../../src/kya/credential.js';
import {
  KeyStoreError,
  initIssuer,
  loadIssuer,
  loadSigningIssuer,
  readCredential,
  storePaths,
  writeCredential,
} from '../../src/kya/store.js';
import { NOW } from '../engine/fixtures.js';

const posix = process.platform !== 'win32';

let dir: string;
let home: string;
let config: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mandate-test-'));
  home = join(dir, '.imprest');
  config = join(dir, 'mandate.yaml');
});

const add = (o: Partial<Parameters<typeof runAgentAdd>[0]> = {}) =>
  runAgentAdd({
    home,
    config,
    id: 'lab-procurement',
    days: 90,
    scope: ['payments:request'],
    force: false,
    now: NOW,
    ...o,
  });

describe('imprest init', () => {
  it('creates the key pair, a starter config and a .gitignore', () => {
    const out = runInit({ home, config });
    const p = storePaths(home);
    expect(existsSync(p.privateKey)).toBe(true);
    expect(existsSync(p.publicKey)).toBe(true);
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(config, 'utf8')).toMatch(/fictional/);
    expect(out).toMatch(/^Created issuer imprest-issuer:[0-9a-f]{16}/);
  });

  it('never prints the private key', () => {
    const out = runInit({ home, config });
    const pem = readFileSync(storePaths(home).privateKey, 'utf8');
    const body = pem.split('\n')[1] ?? '';
    expect(body.length).toBeGreaterThan(20);
    expect(out).not.toContain(body);
    expect(out).not.toMatch(/PRIVATE KEY-----/);
  });

  it.runIf(posix)('writes the private key with mode 0600', () => {
    runInit({ home, config });
    expect(statSync(storePaths(home).privateKey).mode & 0o777).toBe(0o600);
  });

  it('keeps an existing mandate.yaml', () => {
    writeFileSync(config, 'mine');
    expect(runInit({ home, config })).toMatch(/Kept your existing/);
    expect(readFileSync(config, 'utf8')).toBe('mine');
  });

  it('refuses to init over a lone public key too', () => {
    initIssuer(home);
    unlinkSync(storePaths(home).privateKey);
    expect(() => initIssuer(home)).toThrow(/already exists/);
  });

  it('refuses to replace an existing issuer key', () => {
    runInit({ home, config });
    const before = readFileSync(storePaths(home).privateKey, 'utf8');
    expect(() => runInit({ home, config })).toThrow(/already exists/);
    expect(readFileSync(storePaths(home).privateKey, 'utf8')).toBe(before);
  });
});

describe('imprest agent add', () => {
  beforeEach(() => runInit({ home, config }));

  it('issues a credential with the owner and organisation from mandate.yaml', () => {
    const out = add();
    const c = readCredential(home, 'lab-procurement');
    expect(c.claims).toMatchObject({
      issuer: loadIssuer(home).id,
      agent_id: 'lab-procurement',
      agent_name: 'lab-procurement',
      owner: 'M. Keller, Head of Lab',
      organisation: 'Example Labs AG (fictional)',
      scope: ['payments:request'],
    });
    expect(out).toMatch(/Issued credential for agent "lab-procurement"/);
    expect(out).not.toContain(c.signature);
  });

  it('takes --name, --org, --days and --scope', () => {
    add({ name: 'Lab bot', org: 'Other Org', days: 7, scope: ['payments:request', 'x'] });
    const { claims } = readCredential(home, 'lab-procurement');
    expect(claims).toMatchObject({
      agent_name: 'Lab bot',
      organisation: 'Other Org',
      scope: ['payments:request', 'x'],
      expires_at: '2026-10-28T10:00:00.000Z',
    });
  });

  it('refuses an agent that has no mandate', () => {
    expect(() => add({ id: 'ghost' })).toThrow(/"ghost" is not in .*agents: lab-procurement/);
  });

  it('needs an organisation', () => {
    writeFileSync(config, readFileSync(config, 'utf8').replace(/^organisation:.*$/m, ''));
    expect(() => add()).toThrow(/Set "organisation"/);
  });

  it('refuses to overwrite a credential unless forced', () => {
    add();
    expect(() => add()).toThrow(/already has a credential/);
    expect(() => add({ force: true, days: 1 })).not.toThrow();
    expect(readCredential(home, 'lab-procurement').claims.expires_at).toBe(
      '2026-10-22T10:00:00.000Z',
    );
  });

  it('needs imprest init first', () => {
    expect(() => add({ home: join(dir, 'elsewhere') })).toThrow(/Run "imprest init" first/);
    expect(() => loadIssuer(join(dir, 'elsewhere'))).toThrow(/Run "imprest init" first/);
  });
});

describe('key store safety', () => {
  beforeEach(() => runInit({ home, config }));

  it.runIf(posix)('refuses a private key readable by other users', () => {
    chmodSync(storePaths(home).privateKey, 0o644);
    expect(() => loadSigningIssuer(home)).toThrow(/readable by other users/);
  });

  it('refuses a private key that does not match the public key', () => {
    writeFileSync(storePaths(home).privateKey, generateKeyPair().privateKeyPem, { mode: 0o600 });
    expect(() => loadSigningIssuer(home)).toThrow(/not a key pair/);
  });

  it('refuses a garbage private key without echoing its contents', () => {
    writeFileSync(storePaths(home).privateKey, 'SECRET-GARBAGE', { mode: 0o600 });
    expect(() => loadSigningIssuer(home)).toThrow(KeyStoreError);
    expect(() => loadSigningIssuer(home)).not.toThrow(/SECRET-GARBAGE/);
  });

  it('refuses a garbage public key', () => {
    writeFileSync(storePaths(home).publicKey, 'nope');
    expect(() => loadIssuer(home)).toThrow(/not an Ed25519 public key/);
  });

  it('refuses a non-Ed25519 public key', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(storePaths(home).publicKey, publicKey);
    expect(() => loadIssuer(home)).toThrow(/not an Ed25519 public key/);
  });

  it.each(['../evil', 'UPPER', 'a/b', ''])('rejects agent id %j as a file name', (id) => {
    expect(() => readCredential(home, id)).toThrow(/not a valid agent id/);
  });

  it('reports a missing or malformed credential clearly', () => {
    expect(() => readCredential(home, 'nobody')).toThrow(CredentialError);
    writeFileSync(join(storePaths(home).credentials, 'broken.json'), '{"format":1}');
    expect(() => readCredential(home, 'broken')).toThrow(/malformed/);
  });

  it('writeCredential refuses an overwrite without force', () => {
    add();
    const c = readCredential(home, 'lab-procurement');
    expect(() => writeCredential(home, c)).toThrow(KeyStoreError);
    expect(writeCredential(home, c, true)).toMatch(/lab-procurement\.json$/);
  });

  it('initIssuer works on a fresh directory', () => {
    expect(initIssuer(join(dir, 'fresh')).id).toMatch(/^imprest-issuer:/);
  });
});
