import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from './client';

const MAX_CACHE_PAGES = 12;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

export interface CuratedCatalogCachePage<Response> {
  query: string;
  fetchedAt: number;
  response: Response;
}

export function curatedCatalogCredentialIdentity(
  context: CanopyCloudCredentialContext,
): string {
  return createHash('sha256')
    .update(`${BRAND.web.apiNamespace}\0${context.baseUrl}\0${context.apiKey}`)
    .digest('hex');
}

export async function assertCurrentCuratedCatalogCredentials(
  context: CanopyCloudCredentialContext,
): Promise<void> {
  if (
    curatedCatalogCredentialIdentity(
      await resolveCanopyCloudCredentialContext(),
    ) !== curatedCatalogCredentialIdentity(context)
  ) {
    throw new Error(
      `Your ${BRAND.displayName} Cloud account changed. Refresh the catalog and try again.`,
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CuratedCatalogPageCache<Response> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      filePath: () => string;
      isResponse: (value: unknown) => value is Response;
      projectResponse: (response: Response) => Response;
    },
  ) {}

  async read(): Promise<Array<CuratedCatalogCachePage<Response>>> {
    try {
      const file = this.options.filePath();
      if ((await stat(file)).size > MAX_CACHE_BYTES) return [];
      const raw = await readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_CACHE_BYTES) return [];
      const value: unknown = JSON.parse(raw);
      if (
        !record(value) ||
        value.version !== 1 ||
        value.brand !== BRAND.web.apiNamespace ||
        !Array.isArray(value.pages)
      ) {
        return [];
      }
      return value.pages
        .filter(
          (page): page is CuratedCatalogCachePage<Response> =>
            record(page) &&
            typeof page.query === 'string' &&
            page.query.length <= 4096 &&
            typeof page.fetchedAt === 'number' &&
            Number.isFinite(page.fetchedAt) &&
            this.options.isResponse(page.response),
        )
        .slice(-MAX_CACHE_PAGES)
        .map((page) => ({
          ...page,
          response: this.options.projectResponse(page.response),
        }));
    } catch {
      return [];
    }
  }

  async write(page: CuratedCatalogCachePage<Response>): Promise<void> {
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        const pages = (await this.read()).filter(
          (existing) => existing.query !== page.query,
        );
        pages.push(page);
        const file = this.options.filePath();
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        const boundedPages = pages.slice(-MAX_CACHE_PAGES);
        const serialize = (): string =>
          JSON.stringify({
            version: 1,
            brand: BRAND.web.apiNamespace,
            pages: boundedPages,
          });
        let serialized = serialize();
        while (
          Buffer.byteLength(serialized) > MAX_CACHE_BYTES &&
          boundedPages.length > 1
        ) {
          boundedPages.shift();
          serialized = serialize();
        }
        try {
          await writeFile(temporary, serialized, 'utf8');
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
    this.queue = operation;
    await operation;
  }
}
