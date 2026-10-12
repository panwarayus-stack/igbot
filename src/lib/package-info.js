import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** Name and version from package.json, used by !info and startup logs. */
export const packageInfo = Object.freeze({ name: pkg.name, version: pkg.version });
