import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persists the outcome of authentication failures so that a restart does not
 * trigger another login attempt straight away. Only the failure code and timestamps
 * are stored, never credentials.
 */
export class AuthGuard {
  /**
   * @param {object} options
   * @param {string} options.filePath
   * @param {import('pino').Logger} options.logger
   * @param {() => number} [options.now]
   */
  constructor({ filePath, logger, now = () => Date.now() }) {
    this.filePath = filePath;
    this.logger = logger;
    this.now = now;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn('Auth state file is unreadable; ignoring it');
      }
      return {};
    }
  }

  async #write(state) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  /**
   * @returns {Promise<{ allowed: true } | { allowed: false, code: string, retryAfter: string }>}
   */
  async check() {
    const { failure } = await this.#read();
    if (!failure) return { allowed: true };
    const retryAt = Date.parse(failure.retryAfter);
    if (Number.isFinite(retryAt) && this.now() < retryAt) {
      return { allowed: false, code: failure.code, retryAfter: failure.retryAfter };
    }
    return { allowed: true };
  }

  /**
   * @param {string} code machine-readable failure code, e.g. "BAD_PASSWORD"
   * @param {number} cooldownMs
   */
  async recordFailure(code, cooldownMs) {
    const at = this.now();
    await this.#write({
      failure: {
        code,
        at: new Date(at).toISOString(),
        retryAfter: new Date(at + cooldownMs).toISOString(),
      },
    });
    this.logger.warn({ code, retryAfter: new Date(at + cooldownMs).toISOString() }, 'Login cooldown set');
  }

  async recordSuccess() {
    await rm(this.filePath, { force: true });
  }
}
