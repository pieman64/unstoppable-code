import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES,
  AI_GATEWAY_MODEL_CATALOG_VERSION,
  parseAiGatewayModelCatalogResponse,
} from '@canopy/protocol/ai-gateway-models';
import {
  AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION,
  normalizeAiGatewayCatalogServerOrigin,
  readAiGatewayModelCatalogCache,
  type AiGatewayModelCatalogCacheFile,
} from './cache';

export const AI_GATEWAY_MODEL_CATALOG_FETCH_TIMEOUT_MS = 5_000;
export const AI_GATEWAY_MODEL_CATALOG_LOCK_STALE_MS = 30_000;

export type AiGatewayModelCatalogRefreshResult =
  | {
      status: 'updated' | 'not-modified';
      cache: AiGatewayModelCatalogCacheFile;
    }
  | { status: 'busy' }
  | { status: 'failed'; error: unknown };

export interface AiGatewayCatalogFs {
  mkdir(path: string): Promise<void>;
  openExclusive(path: string): Promise<FileHandle>;
  statMtime(path: string): Promise<number>;
  unlink(path: string): Promise<void>;
  write(path: string, value: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  read(path: string): Promise<string>;
}

const defaultFs: AiGatewayCatalogFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  openExclusive: (path) => open(path, 'wx'),
  statMtime: async (path) => (await stat(path)).mtimeMs,
  unlink: async (path) => {
    await unlink(path);
  },
  write: (path, value) => writeFile(path, value, { encoding: 'utf8' }),
  rename: (from, to) => rename(from, to),
  read: (path) => readFile(path, 'utf8'),
};

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

async function acquireLock(options: {
  lockPath: string;
  now: number;
  fs: AiGatewayCatalogFs;
}): Promise<FileHandle | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await options.fs.openExclusive(options.lockPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt > 0) return undefined;
      try {
        const mtime = await options.fs.statMtime(options.lockPath);
        if (options.now - mtime <= AI_GATEWAY_MODEL_CATALOG_LOCK_STALE_MS) {
          return undefined;
        }
        await options.fs.unlink(options.lockPath);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export async function refreshAiGatewayModelCatalog(options: {
  cacheFilePath: string;
  serverOrigin: string;
  brandApiNamespace: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  fs?: AiGatewayCatalogFs;
  signal?: AbortSignal;
}): Promise<AiGatewayModelCatalogRefreshResult> {
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? Date.now;
  const lockPath = `${options.cacheFilePath}.lock`;
  const tempPath = `${options.cacheFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let lock: FileHandle | undefined;
  let ownsTemp = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let externalAbortListener: (() => void) | undefined;

  try {
    const origin = normalizeAiGatewayCatalogServerOrigin(options.serverOrigin);
    await fs.mkdir(dirname(options.cacheFilePath));
    lock = await acquireLock({ lockPath, now: now(), fs });
    if (!lock) return { status: 'busy' };

    const existing = await readAiGatewayModelCatalogCache({
      cacheFilePath: options.cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: options.brandApiNamespace,
      now,
      readText: (path) => fs.read(path),
    });
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    externalAbortListener = abort;
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', externalAbortListener, {
        once: true,
      });
    }
    timeout = setTimeout(abort, AI_GATEWAY_MODEL_CATALOG_FETCH_TIMEOUT_MS);
    timeout.unref?.();
    const headers: Record<string, string> = {};
    if (existing.entry?.etag) {
      headers['If-None-Match'] = existing.entry.etag;
    }
    // `catalogVersion` is an explicit opt-in so the CDN caches each wire shape
    // separately and older builds that never send it keep getting v1.
    const response = await (options.fetchFn ?? fetch)(
      `${origin}/api/v1/${encodeURIComponent(options.brandApiNamespace)}/ai-gateway/models?catalogVersion=${AI_GATEWAY_MODEL_CATALOG_VERSION}`,
      { headers, signal: controller.signal },
    );

    let next: AiGatewayModelCatalogCacheFile;
    let status: 'updated' | 'not-modified';
    if (response.status === 304 && existing.entry) {
      next = { ...existing.entry, fetchedAt: new Date(now()).toISOString() };
      status = 'not-modified';
    } else {
      if (!response.ok) {
        throw new Error(`Catalog request failed with HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES
      ) {
        throw new Error('Catalog response exceeds 1 MiB');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES) {
        throw new Error('Catalog response exceeds 1 MiB');
      }
      const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const catalog = parseAiGatewayModelCatalogResponse(raw, bytes.byteLength);
      next = {
        cacheVersion: AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION,
        serverOrigin: origin,
        brandApiNamespace: options.brandApiNamespace,
        fetchedAt: new Date(now()).toISOString(),
        ...(response.headers.get('etag')
          ? { etag: response.headers.get('etag') ?? undefined }
          : {}),
        catalog,
      };
      status = 'updated';
    }

    ownsTemp = true;
    await fs.write(tempPath, `${JSON.stringify(next)}\n`);
    await fs.rename(tempPath, options.cacheFilePath);
    ownsTemp = false;
    return { status, cache: next };
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    if (externalAbortListener) {
      options.signal?.removeEventListener('abort', externalAbortListener);
    }
    if (timeout) clearTimeout(timeout);
    if (ownsTemp) await fs.unlink(tempPath).catch(() => undefined);
    if (lock) {
      await lock.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}
