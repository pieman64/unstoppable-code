import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isCliEntrypoint(moduleUrl, entrypoint = process.argv[1]) {
  if (!entrypoint) return false;
  const entrypointPath = resolve(entrypoint);
  const modulePath = fileURLToPath(moduleUrl);
  return process.platform === 'win32'
    ? entrypointPath.toLowerCase() === modulePath.toLowerCase()
    : entrypointPath === modulePath;
}
