import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;

/**
 * Stores the Instagram session encrypted at rest (AES-256-GCM, key derived
 * from SESSION_SECRET with scrypt). The plaintext is never written to disk.
 * Writes are atomic and the file is created with mode 0600.
 */
export class SessionStore {
  /**
   * @param {object} options
   * @param {string} options.filePath
   * @param {string} options.secret
   * @param {import('pino').Logger} options.logger
   */
  constructor({ filePath, secret, logger }) {
    if (!secret || secret.length < 32) {
      throw new TypeError('SessionStore requires a secret of at least 32 characters');
    }
    this.filePath = filePath;
    this.secret = secret;
    this.logger = logger;
  }

  #deriveKey(salt) {
    return scryptSync(this.secret, salt, KEY_BYTES);
  }

  /** @param {string} plaintext serialized session state */
  async save(plaintext) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#deriveKey(salt), iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = JSON.stringify({
      v: FORMAT_VERSION,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.filePath);
    this.logger.debug('Session saved');
  }

  /** @returns {Promise<string | null>} plaintext session, or null if absent/unreadable */
  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    try {
      const payload = JSON.parse(raw);
      if (payload.v !== FORMAT_VERSION) throw new Error('unsupported session format');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#deriveKey(Buffer.from(payload.salt, 'base64')),
        Buffer.from(payload.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // Wrong SESSION_SECRET, corruption, or tampering. Treat as "no session".
      this.logger.warn('Saved session could not be decrypted and will be ignored');
      return null;
    }
  }

  async clear() {
    await rm(this.filePath, { force: true });
    this.logger.info('Saved session removed');
  }
}
