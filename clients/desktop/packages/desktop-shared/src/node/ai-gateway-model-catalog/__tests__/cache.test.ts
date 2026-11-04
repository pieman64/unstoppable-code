import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AI_GATEWAY_MODEL_CATALOG_TTL_MS,
  readAiGatewayModelCatalogCache,
} from '../cache';
import {
  refreshAiGatewayModelCatalog,
  type AiGatewayCatalogFs,
} from '../client';

const origin = 'https://cloud.example.com';
const namespace = 'canopy';
const response = {
  version: 9,
  models: [
    {
      id: 'model-a',
      gatewayId: 'provider/model-a',
      label: 'Model A',
      family: 'openai',
      familyLabel: 'OpenAI',
      recommendedHarness: 'codex',
      contextWindow: 100_000,
      supportsPromptCaching: false,
      requiresLocalHarnessSupport: false,
      showMoreOnly: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  ],
};

describe('AI Gateway model catalog cache', () => {
  let directory: string;
  let cacheFilePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-model-catalog-'));
    cacheFilePath = join(directory, 'model-catalog', 'ai-gateway-v1.json');
    await mkdir(join(directory, 'model-catalog'), { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('promotes a matching v6 cache as stale and drops the old representation ETag', async () => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 6,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: new Date().toISOString(),
        etag: 'v6-representation',
        catalog: { ...response, version: 6 },
      }),
    );
    const cached = await readAiGatewayModelCatalogCache({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
    });
    expect(cached).toMatchObject({
      freshness: 'stale',
      entry: {
        cacheVersion: 9,
        catalog: response,
      },
    });
    if (cached.freshness !== 'missing')
      expect(cached.entry?.etag).toBeUndefined();
    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: 'https://other.example.com',
        brandApiNamespace: namespace,
      }),
    ).resolves.toEqual({ freshness: 'missing' });
  });

  it('promotes a matching v7 cache as stale and drops the old representation ETag', async () => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 7,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: new Date().toISOString(),
        etag: 'v7-representation',
        catalog: {
          ...response,
          version: 7,
          models: [{ ...response.models[0], cursorModelId: 'model-a' }],
        },
      }),
    );
    const cached = await readAiGatewayModelCatalogCache({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
    });

    expect(cached).toMatchObject({
      freshness: 'stale',
      entry: {
        cacheVersion: 9,
        catalog: {
          version: 9,
          models: [{ ...response.models[0], cursorModelId: 'model-a' }],
        },
      },
    });
    expect(cached.entry?.etag).toBeUndefined();
  });

  it('promotes a v8 cache as stale without retaining its representation ETag', async () => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 8,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: new Date().toISOString(),
        etag: 'v8-etag',
        catalog: { ...response, version: 8 },
      }),
    );
    const cached = await readAiGatewayModelCatalogCache({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
    });
    expect(cached.freshness).toBe('stale');
    expect(cached.entry?.catalog.version).toBe(9);
    expect(cached.entry?.etag).toBeUndefined();
  });

  it('fetches and caches exact effort metadata without inventing Off', async () => {
    const exact = {
      ...response,
      models: [
        {
          ...response.models[0],
          supportedThinkingLevels: ['low', 'high'],
          thinkingLevelsExact: true,
        },
      ],
    };
    const fetchFn = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(exact), {
        status: 200,
        headers: { ETag: 'v9-exact' },
      }),
    );
    const refreshed = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn,
    });
    expect(refreshed).toMatchObject({
      status: 'updated',
      cache: { catalog: exact },
    });
    const cached = await readAiGatewayModelCatalogCache({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
    });
    expect(cached.entry?.catalog.models[0]).toMatchObject({
      thinkingLevelsExact: true,
      supportedThinkingLevels: ['low', 'high'],
    });
  });

  it('ignores a cache whose catalog version does not match its cache version', async () => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 7,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: new Date().toISOString(),
        catalog: { ...response, version: 6 },
      }),
    );

    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
      }),
    ).resolves.toEqual({ freshness: 'missing' });
  });

  it('classifies valid matching cache files as fresh or stale', async () => {
    const fetchedAt = '2026-07-29T12:00:00.000Z';
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 9,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt,
        catalog: response,
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
    const base = Date.parse(fetchedAt);
    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        now: () => base + 1,
      }),
    ).resolves.toMatchObject({ freshness: 'fresh' });
    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        now: () => base + AI_GATEWAY_MODEL_CATALOG_TTL_MS,
      }),
    ).resolves.toMatchObject({ freshness: 'stale' });
  });

  it.each([
    ['wrong origin', { serverOrigin: 'https://other.example.com' }],
    ['wrong brand', { brandApiNamespace: 'other' }],
    ['unsupported version', { cacheVersion: 1 }],
    ['invalid catalog', { catalog: { version: 5, models: [{ bad: true }] } }],
  ])('ignores a cache with %s', async (_name, replacement) => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 9,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: '2026-07-29T12:00:00.000Z',
        catalog: response,
        ...replacement,
      }),
    );

    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
      }),
    ).resolves.toEqual({ freshness: 'missing' });
  });

  it('opts into the versioned catalog wire shape via query parameter', async () => {
    const fetchFn: jest.MockedFunction<typeof fetch> = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      );

    await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `${origin}/api/v1/${namespace}/ai-gateway/models?catalogVersion=9`,
    );
  });

  it('discards a cache written by an older catalog wire version', async () => {
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        cacheVersion: 1,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchedAt: new Date().toISOString(),
        catalog: {
          version: 1,
          models: [
            {
              id: 'model-a',
              gatewayId: 'provider/model-a',
              label: 'Model A',
              recommendedHarness: 'codex',
              contextWindow: 100_000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      }),
    );

    await expect(
      readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
      }),
    ).resolves.toEqual({ freshness: 'missing' });
  });

  it('atomically persists valid 200 data and advances 304 freshness', async () => {
    const first = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: `${origin}/ignored`,
      brandApiNamespace: namespace,
      now: () => Date.parse('2026-07-29T12:00:00.000Z'),
      fetchFn: jest.fn().mockResolvedValue(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { ETag: '"one"' },
        }),
      ),
    });
    expect(first).toMatchObject({ status: 'updated' });

    const second = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      now: () => Date.parse('2026-07-29T12:05:00.000Z'),
      fetchFn: jest.fn().mockResolvedValue(new Response(null, { status: 304 })),
    });
    expect(second).toMatchObject({ status: 'not-modified' });
    expect(JSON.parse(await readFile(cacheFilePath, 'utf8'))).toMatchObject({
      fetchedAt: '2026-07-29T12:05:00.000Z',
      etag: '"one"',
      catalog: response,
    });
  });

  it('retains the last known good file after invalid refresh data', async () => {
    const validFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      );
    await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: validFetch,
    });
    const before = await readFile(cacheFilePath, 'utf8');
    const result = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest.fn().mockResolvedValue(
        new Response('{"version":1,"models":[{"bad":true}]}', {
          status: 200,
        }),
      ),
    });
    expect(result.status).toBe('failed');
    expect(await readFile(cacheFilePath, 'utf8')).toBe(before);
  });

  it('accepts an empty catalog as a valid replacement', async () => {
    const result = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: 9, models: [] }), {
          status: 200,
        }),
      ),
    });

    expect(result).toMatchObject({
      status: 'updated',
      cache: { catalog: { version: 9, models: [] } },
    });
  });

  it('promotes a v7 response from an older server to the current catalog', async () => {
    const result = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...response, version: 7 }), {
          status: 200,
        }),
      ),
    });

    expect(result).toMatchObject({
      status: 'updated',
      cache: { cacheVersion: 9, catalog: response },
    });
  });

  it('keeps a catalog whose model belongs to a family this build has never seen', async () => {
    const withNewFamily = {
      ...response,
      models: [
        ...response.models,
        {
          ...response.models[0],
          id: 'model-b',
          gatewayId: 'mistral/model-b',
          family: 'mistral',
          familyLabel: 'Mistral AI',
        },
      ],
    };
    const result = await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(withNewFamily), { status: 200 }),
        ),
    });

    expect(result).toMatchObject({
      status: 'updated',
      cache: { catalog: withNewFamily },
    });
  });

  it('returns busy while another refresh owns the live lock', async () => {
    let finishFetch: ((response: Response) => void) | undefined;
    const fetchFn: typeof fetch = jest.fn<
      Promise<Response>,
      [input: URL | RequestInfo, init?: RequestInit]
    >(
      () =>
        new Promise<Response>((resolveFetch) => {
          finishFetch = resolveFetch;
        }),
    );
    const first = refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn,
    });
    while (!finishFetch) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn: jest.fn(),
      }),
    ).resolves.toEqual({ status: 'busy' });

    finishFetch(
      new Response(JSON.stringify(response), {
        status: 200,
      }),
    );
    await expect(first).resolves.toMatchObject({ status: 'updated' });
  });

  it('removes a stale lock and retries the refresh once', async () => {
    const lockPath = `${cacheFilePath}.lock`;
    await writeFile(lockPath, 'orphan');
    const staleTime = new Date(Date.now() - 31_000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn: jest.fn().mockResolvedValue(
          new Response(JSON.stringify(response), {
            status: 200,
          }),
        ),
      }),
    ).resolves.toMatchObject({ status: 'updated' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains valid disk data after a server failure', async () => {
    await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    });
    const before = await readFile(cacheFilePath, 'utf8');

    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn: jest
          .fn()
          .mockResolvedValue(new Response('unavailable', { status: 503 })),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(await readFile(cacheFilePath, 'utf8')).toBe(before);
  });

  it.each<[string, () => Response]>([
    [
      'malformed JSON',
      (): Response => new Response('{"version":1,', { status: 200 }),
    ],
    [
      'an invalid enum',
      (): Response =>
        new Response(
          JSON.stringify({
            ...response,
            models: [
              {
                ...response.models[0],
                supportedThinkingLevels: ['impossible'],
              },
            ],
          }),
          { status: 200 },
        ),
    ],
    [
      'an oversized body',
      (): Response =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          status: 200,
        }),
    ],
    [
      'an oversized declared content length',
      (): Response =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Length': String(1024 * 1024 + 1) },
        }),
    ],
  ])(
    'retains last-known-good data after %s',
    async (_name, responseFactory) => {
      await refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn: jest
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(response), { status: 200 }),
          ),
      });
      const before = await readFile(cacheFilePath, 'utf8');

      await expect(
        refreshAiGatewayModelCatalog({
          cacheFilePath,
          serverOrigin: origin,
          brandApiNamespace: namespace,
          fetchFn: jest.fn().mockResolvedValue(responseFactory()),
        }),
      ).resolves.toMatchObject({ status: 'failed' });
      expect(await readFile(cacheFilePath, 'utf8')).toBe(before);
    },
  );

  it('aborts a timed-out request and retains last-known-good data', async () => {
    await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    });
    const before = await readFile(cacheFilePath, 'utf8');
    jest.useFakeTimers();
    try {
      const fetchFn: jest.MockedFunction<typeof fetch> = jest.fn(
        (
          _url: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      );
      const result = refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn,
      });
      while (fetchFn.mock.calls.length === 0) {
        await jest.advanceTimersByTimeAsync(0);
      }
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toMatchObject({ status: 'failed' });
    } finally {
      jest.useRealTimers();
    }
    expect(await readFile(cacheFilePath, 'utf8')).toBe(before);
  }, 10_000);

  it('honors a refresh signal that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('disposed'));
    const fetchFn: jest.MockedFunction<typeof fetch> = jest.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return init?.signal?.aborted
          ? Promise.reject(
              init.signal.reason instanceof Error
                ? init.signal.reason
                : new Error('Refresh aborted'),
            )
          : Promise.resolve(
              new Response(JSON.stringify(response), { status: 200 }),
            );
      },
    );

    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(stat(cacheFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a failed result for an invalid server origin', async () => {
    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: 'not a URL',
        brandApiNamespace: namespace,
        fetchFn: jest.fn(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('cleans up its lock and temp file after an injected write failure', async () => {
    await refreshAiGatewayModelCatalog({
      cacheFilePath,
      serverOrigin: origin,
      brandApiNamespace: namespace,
      fetchFn: jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    });
    const before = await readFile(cacheFilePath, 'utf8');

    await expect(
      refreshAiGatewayModelCatalog({
        cacheFilePath,
        serverOrigin: origin,
        brandApiNamespace: namespace,
        fetchFn: jest
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(response), { status: 200 }),
          ),
        fs: {
          mkdir: async (path): Promise<void> => {
            await mkdir(path, { recursive: true });
          },
          openExclusive: (path): Promise<FileHandle> => open(path, 'wx'),
          statMtime: async (path): Promise<number> =>
            (await stat(path)).mtimeMs,
          unlink,
          write: (): Promise<void> =>
            Promise.reject(new Error('injected write failure')),
          rename,
          read: (path): Promise<string> => readFile(path, 'utf8'),
        } satisfies AiGatewayCatalogFs,
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(await readFile(cacheFilePath, 'utf8')).toBe(before);
    await expect(stat(`${cacheFilePath}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(join(directory, 'model-catalog'))).toEqual([
      'ai-gateway-v1.json',
    ]);
  });

  it('coordinates refresh locking across separate Node processes', async () => {
    const fixture = resolve(__dirname, 'fixtures', 'catalog-refresh-child.ts');
    const runChild = (
      holdLock: boolean,
    ): {
      child: ReturnType<typeof spawn>;
      ready: Promise<void>;
      completed: Promise<{ code: number | null; stdout: string }>;
    } => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fixture, cacheFilePath, holdLock ? 'hold' : 'run'],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
      );
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('close', () => clearTimeout(deadline));
      let stdout = '';
      const output = child.stdout;
      if (!output) throw new Error('Expected child stdout pipe');
      output.setEncoding('utf8');
      output.on('data', (chunk: string) => {
        stdout += chunk;
      });
      return {
        child,
        ready: holdLock
          ? new Promise<void>((resolveReady, rejectReady) => {
              child.once('message', (message) => {
                if (message === 'lock-held') resolveReady();
                else
                  rejectReady(new Error('Unexpected child readiness message'));
              });
              child.once('error', rejectReady);
              child.once('close', () =>
                rejectReady(new Error('Child exited before acquiring lock')),
              );
            })
          : Promise.resolve(),
        completed: new Promise<{ code: number | null; stdout: string }>(
          (resolveChild, rejectChild) => {
            child.once('error', rejectChild);
            child.on('close', (code) => resolveChild({ code, stdout }));
          },
        ),
      };
    };

    const first = runChild(true);
    const children = [first];
    try {
      await first.ready;
      await stat(`${cacheFilePath}.lock`);
      // Keep the first refresh inside fetch until the competing process exits.
      // Process startup speed must not determine whether this exercises the lock.
      const second = runChild(false);
      children.push(second);
      const completedSecond = await second.completed;
      expect(completedSecond.code).toBe(0);
      expect(JSON.parse(completedSecond.stdout)).toEqual({ status: 'busy' });

      first.child.send('release');
      const completedFirst = await first.completed;
      expect(completedFirst.code).toBe(0);
      expect(JSON.parse(completedFirst.stdout)).toEqual({ status: 'updated' });
      expect(await readdir(join(directory, 'model-catalog'))).toEqual([
        'ai-gateway-v1.json',
      ]);
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await Promise.allSettled(children.map(({ completed }) => completed));
    }
  }, 15_000);
});
