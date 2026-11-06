import { createHash } from 'node:crypto';

/** The run-log file stem of a script key; every host that writes run logs uses it. */
export function scriptRunFileStem(scriptKey: string): string {
  const prefix = scriptKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const digest = createHash('sha256')
    .update(scriptKey)
    .digest('hex')
    .slice(0, 12);
  return `${prefix || 'script'}__${digest}`;
}
