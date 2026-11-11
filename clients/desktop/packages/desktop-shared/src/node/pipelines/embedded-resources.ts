import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCanopyCacheDir } from '@canopy/execution-engine/canopy-paths';

function loadEmbeddedData(): Record<string, string> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('canopy:embedded-resources') as Record<string, string>;
  } catch {
    return null;
  }
}

let cachedRoot: string | null | undefined;

export function extractEmbeddedResources(): string | null {
  if (cachedRoot !== undefined) {
    return cachedRoot;
  }

  const data = loadEmbeddedData();
  if (!data) {
    cachedRoot = null;
    return null;
  }

  const hash = crypto.createHash('sha256');
  const keys = Object.keys(data).sort();
  for (const key of keys) {
    hash.update(key);
    hash.update(data[key]);
  }
  const digest = hash.digest('hex').slice(0, 12);

  const root = path.join(getCanopyCacheDir(), `embedded-resources-${digest}`);

  const sentinel = path.join(root, '.extracted');
  if (fs.existsSync(sentinel)) {
    cachedRoot = root;
    return root;
  }

  for (const [relPath, content] of Object.entries(data)) {
    const dest = path.join(root, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }

  fs.writeFileSync(sentinel, new Date().toISOString(), 'utf8');

  cachedRoot = root;
  return root;
}
