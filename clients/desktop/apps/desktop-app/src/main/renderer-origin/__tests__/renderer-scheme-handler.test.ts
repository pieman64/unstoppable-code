import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  RENDERER_SCHEME,
  RENDERER_SCHEME_HOST,
  RENDERER_SCHEME_ORIGIN,
  isRendererSchemeUrl,
} from '@canopy/desktop-shared/lib/renderer-scheme';
import {
  RENDERER_STORAGE_BRIDGE_PAGE,
  createRendererSchemeHandler,
  rendererSchemeContentType,
  type RendererSchemeFileSystem,
} from '../renderer-scheme-handler';

/**
 * Security tests for the privileged renderer scheme handler. Requests are
 * passed as raw `{ url, method }` objects so the handler's own checks are
 * exercised even for URL strings Chromium would have normalized first.
 */

let sandbox: string;
let rootDir: string;
let outsideDir: string;
const reads: string[] = [];

function trackingFs(): RendererSchemeFileSystem {
  return {
    realpath: (path) => realpath(path),
    stat: (path) => stat(path),
    readFile: (path): Promise<Buffer> => {
      reads.push(path);
      return readFile(path);
    },
  };
}

function request(url: string, method = 'GET'): { url: string; method: string } {
  return { url, method };
}

beforeEach(() => {
  reads.length = 0;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'renderer-scheme-')));
  rootDir = join(sandbox, 'out', 'renderer');
  outsideDir = join(sandbox, 'outside');
  mkdirSync(join(rootDir, 'assets', 'nested'), { recursive: true });
  mkdirSync(join(rootDir, 'pdf-worker'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(rootDir, 'index.html'), '<!doctype html><div id="root">');
  writeFileSync(join(rootDir, 'app-advisor.html'), '<!doctype html>');
  writeFileSync(join(rootDir, 'assets', 'index-AbC_d-12.js'), 'export {};');
  writeFileSync(join(rootDir, 'assets', 'index-AbC_d-12.css'), 'body{}');
  writeFileSync(join(rootDir, 'assets', 'nested', 'deep.json'), '{}');
  writeFileSync(join(rootDir, 'assets', 'module.wasm'), Buffer.from([0, 97]));
  writeFileSync(join(rootDir, 'assets', 'font.woff2'), 'font');
  writeFileSync(join(rootDir, 'assets', 'font.woff'), 'font');
  writeFileSync(join(rootDir, 'assets', 'font.ttf'), 'font');
  writeFileSync(join(rootDir, 'assets', 'logo.svg'), '<svg/>');
  writeFileSync(join(rootDir, 'assets', 'logo.png'), 'png');
  writeFileSync(join(rootDir, 'assets', 'photo.jpg'), 'jpg');
  writeFileSync(join(rootDir, 'pdf-worker', 'pdf.worker.min.mjs'), '//');
  writeFileSync(join(rootDir, 'assets', 'data.bin'), 'bin');
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
  writeFileSync(join(sandbox, 'out', 'sibling.txt'), 'sibling');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function handler(): ReturnType<typeof createRendererSchemeHandler> {
  return createRendererSchemeHandler({ rootDir, fileSystem: trackingFs() });
}

function expectNoReadOutsideRoot(): void {
  for (const path of reads) {
    expect(path.startsWith(`${rootDir}${sep}`)).toBe(true);
  }
}

describe('renderer scheme constants', () => {
  it('names one standard origin and recognises only its exact host', () => {
    expect(RENDERER_SCHEME).toBe('app-renderer');
    expect(RENDERER_SCHEME_HOST).toBe('bundle');
    expect(RENDERER_SCHEME_ORIGIN).toBe('app-renderer://bundle');
    expect(isRendererSchemeUrl('app-renderer://bundle/index.html')).toBe(true);
    for (const lookAlike of [
      'app-renderer://bundle.evil/index.html',
      'app-renderer://evil/index.html',
      'app-renderer://bundle:8080/index.html',
      'app-renderer://user@bundle/index.html',
      'app-rendererx://bundle/index.html',
      'https://bundle/index.html',
      'file:///bundle/index.html',
      'not a url',
    ]) {
      expect(isRendererSchemeUrl(lookAlike)).toBe(false);
    }
  });
});

describe('renderer scheme handler', () => {
  it('serves files from the renderer directory with their MIME types', async () => {
    const serve = handler();
    const cases: Array<[string, string]> = [
      ['index.html', 'text/html; charset=utf-8'],
      ['app-advisor.html?surface=app-advisor', 'text/html; charset=utf-8'],
      ['assets/index-AbC_d-12.js', 'text/javascript; charset=utf-8'],
      ['assets/index-AbC_d-12.css', 'text/css; charset=utf-8'],
      ['assets/nested/deep.json', 'application/json; charset=utf-8'],
      ['assets/module.wasm', 'application/wasm'],
      ['assets/font.woff2', 'font/woff2'],
      ['assets/font.woff', 'font/woff'],
      ['assets/font.ttf', 'font/ttf'],
      ['assets/logo.svg', 'image/svg+xml'],
      ['assets/logo.png', 'image/png'],
      ['assets/photo.jpg', 'image/jpeg'],
      ['pdf-worker/pdf.worker.min.mjs', 'text/javascript; charset=utf-8'],
      ['assets/data.bin', 'application/octet-stream'],
    ];
    for (const [path, contentType] of cases) {
      const response = await serve(
        request(`${RENDERER_SCHEME_ORIGIN}/${path}`),
      );
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cross-origin-resource-policy')).toBe(
        'same-origin',
      );
    }
    const index = await serve(request(`${RENDERER_SCHEME_ORIGIN}/index.html`));
    expect(await index.text()).toBe('<!doctype html><div id="root">');
    expectNoReadOutsideRoot();
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const serve = handler();
    const head = await serve(
      request(`${RENDERER_SCHEME_ORIGIN}/index.html`, 'HEAD'),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await serve(
        request(`${RENDERER_SCHEME_ORIGIN}/index.html`, method),
      );
      expect(response.status).toBe(405);
    }
    expect(reads).toHaveLength(1);
  });

  it.each([
    '/../outside/secret.txt',
    '/../../outside/secret.txt',
    '/assets/../../outside/secret.txt',
    '/%2e%2e/outside/secret.txt',
    '/%2E%2E/outside/secret.txt',
    '/.%2e/outside/secret.txt',
    '/%2e./outside/secret.txt',
    '/%252e%252e/outside/secret.txt',
    '/%252E%252E%252Foutside%252Fsecret.txt',
    '/..%2foutside%2fsecret.txt',
    '/..%2Foutside%2Fsecret.txt',
    '/assets/..%5c..%5coutside%5csecret.txt',
    '/..\\outside\\secret.txt',
    '/assets\\..\\..\\outside\\secret.txt',
    '/%5c..%5coutside%5csecret.txt',
    `/${encodeURIComponent(join(tmpdir(), 'outside', 'secret.txt'))}`,
    `/${join(tmpdir(), 'outside', 'secret.txt')}`,
    '/%2Fetc%2Fpasswd',
    '//etc/passwd',
    '/C:/Windows/win.ini',
    '/C:%5cWindows%5cwin.ini',
    '/index.html%00.png',
    '/index.html%2500',
    '/assets/%00',
    '/.',
    '/./index.html',
    '/assets/./index-AbC_d-12.js',
    '/.hidden',
    '/%',
    '/%zz',
  ])('rejects the traversal or malformed path %s', async (path) => {
    const response = await handler()(
      request(`${RENDERER_SCHEME_ORIGIN}${path}`),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('secret');
    expectNoReadOutsideRoot();
  });

  it('rejects a symlink that leaves the renderer directory', async () => {
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'escape.txt'));
    symlinkSync(outsideDir, join(rootDir, 'assets', 'linked-dir'));
    symlinkSync(join(sandbox, 'out'), join(rootDir, 'parent-link'));
    const serve = handler();
    for (const path of [
      'escape.txt',
      'assets/linked-dir/secret.txt',
      'parent-link/sibling.txt',
    ]) {
      const response = await serve(
        request(`${RENDERER_SCHEME_ORIGIN}/${path}`),
      );
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    expect(reads).toHaveLength(0);
  });

  it('serves a symlink that stays inside the renderer directory', async () => {
    symlinkSync(
      join(rootDir, 'assets', 'index-AbC_d-12.js'),
      join(rootDir, 'assets', 'alias.js'),
    );
    const response = await handler()(
      request(`${RENDERER_SCHEME_ORIGIN}/assets/alias.js`),
    );
    expect(response.status).toBe(200);
    expectNoReadOutsideRoot();
  });

  it.each([
    'app-renderer://evil/index.html',
    'app-renderer://bundle.evil/index.html',
    'app-renderer://bundle:1234/index.html',
    'app-renderer://user:pass@bundle/index.html',
    'file:///index.html',
    'https://bundle/index.html',
    'not a url',
  ])('rejects the unknown host or scheme %s', async (url) => {
    const response = await handler()(request(url));
    expect(response.status).toBe(404);
    expect(reads).toHaveLength(0);
  });

  it.each(['/', '', '/assets', '/assets/', '/assets/nested/'])(
    'refuses the directory request %s',
    async (path) => {
      const response = await handler()(
        request(`${RENDERER_SCHEME_ORIGIN}${path}`),
      );
      expect(response.status).toBe(404);
      expect(reads).toHaveLength(0);
    },
  );

  it('answers 404 for a missing file', async () => {
    const response = await handler()(
      request(`${RENDERER_SCHEME_ORIGIN}/assets/missing.js`),
    );
    expect(response.status).toBe(404);
  });

  it('serves the storage bridge page from memory, never from disk', async () => {
    const response = await handler()(
      request(`${RENDERER_SCHEME_ORIGIN}/${RENDERER_STORAGE_BRIDGE_PAGE}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    const body = await response.text();
    expect(body).toContain('<!doctype html>');
    expect(body).not.toContain('<script');
    expect(reads).toHaveLength(0);
  });

  it('reports an unexpected file-system failure and answers 500', async () => {
    const failure = new Error('EIO');
    const onError = jest.fn<void, [unknown]>();
    const serve = createRendererSchemeHandler({
      rootDir,
      fileSystem: {
        realpath: (path) => realpath(path),
        stat: (path) => stat(path),
        readFile: () => Promise.reject(failure),
      },
      onError,
    });
    const response = await serve(
      request(`${RENDERER_SCHEME_ORIGIN}/index.html`),
    );
    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('fails closed when the renderer directory itself cannot be resolved', async () => {
    const serve = createRendererSchemeHandler({
      rootDir: join(sandbox, 'missing-root'),
      fileSystem: trackingFs(),
    });
    const response = await serve(
      request(`${RENDERER_SCHEME_ORIGIN}/index.html`),
    );
    expect(response.status).toBe(404);
    expect(reads).toHaveLength(0);
  });
});

describe('rendererSchemeContentType', () => {
  it('maps extensions case-insensitively and defaults to octet-stream', () => {
    expect(rendererSchemeContentType('A.JS')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(rendererSchemeContentType('x.map')).toBe(
      'application/json; charset=utf-8',
    );
    expect(rendererSchemeContentType('noext')).toBe('application/octet-stream');
  });
});
