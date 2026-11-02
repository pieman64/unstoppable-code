import { realpath as realpathCallback } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  RENDERER_SCHEME,
  RENDERER_SCHEME_HOST,
} from '@canopy/desktop-shared/lib/renderer-scheme';

/**
 * The `protocol.handle` handler for the renderer scheme
 * (`app-renderer://bundle/...`). It serves files from one directory, the
 * renderer output `loadFile` uses (`out/renderer` or `out-e2e/renderer`,
 * inside the app archive when packaged), and nothing else:
 *
 * - only `GET` and `HEAD`;
 * - only the `bundle` host, with no port or credentials;
 * - every path segment must match a conservative file-name allow-list after
 *   one percent-decoding, so `.`/`..` (plain, encoded or double-encoded),
 *   backslashes, drive letters, NUL bytes and empty segments are refused
 *   before the file system is touched; the raw request string is checked
 *   too, not only Chromium's normalized URL;
 * - the resolved path, after following symlinks, must stay inside the real
 *   renderer directory;
 * - directories are refused (no index fallback);
 * - the content type comes from a fixed extension table, with
 *   `X-Content-Type-Options: nosniff` and a same-origin resource policy.
 *
 * Every refusal is a plain 404, so a probe learns nothing about the disk.
 * Unexpected read failures answer 500 and are reported, which lets the
 * caller fall back to `file://`.
 */

/** The bridge page main uses to read and write this origin's storage. */
export const RENDERER_STORAGE_BRIDGE_PAGE = 'storage-bridge.html';

/**
 * Served from memory so storage can still be moved back to `file://` when
 * the renderer directory cannot be read over the scheme. No script: main
 * evaluates its own code in it through `executeJavaScript`.
 */
const STORAGE_BRIDGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>';

export interface RendererSchemeFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

export interface RendererSchemeRequest {
  url: string;
  method: string;
}

export interface RendererSchemeHandlerOptions {
  /** The renderer output directory, the one `loadFile` reads from. */
  rootDir: string;
  fileSystem?: RendererSchemeFileSystem;
  /** Called for an unexpected failure that answered 500. */
  onError?: (error: unknown) => void;
}

// `fs.realpath` (not the promise or native variants) is the one Electron's
// archive support patches, so it resolves paths inside `app.asar` too.
const realpathPromise = promisify(realpathCallback);

const nodeFileSystem: RendererSchemeFileSystem = {
  realpath: (path) => realpathPromise(path),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
};

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': HTML_CONTENT_TYPE,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

/** The content type for a served file; unknown extensions are opaque bytes. */
export function rendererSchemeContentType(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}

/**
 * One path segment after a single percent-decoding: starts with a letter,
 * digit or underscore (so never `.` or `..` and never hidden), then only
 * file-name characters Vite and the bundled assets use.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._~@+-]*$/;
const MAX_SEGMENTS = 16;

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * The raw path of a request string, before any URL normalization: what
 * follows `app-renderer://bundle` up to the query or fragment. Null when
 * the string does not start with exactly that origin.
 */
function rawPath(url: string): string | null {
  const prefix = `${RENDERER_SCHEME}://${RENDERER_SCHEME_HOST}`;
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest !== '' && !rest.startsWith('/')) return null;
  const end = rest.search(/[?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The decoded, allow-listed path segments of a request, or null when any
 * check fails. Both the raw request string and the parsed URL must pass.
 */
export function rendererSchemeRequestSegments(url: string): string[] | null {
  const raw = rawPath(url);
  if (raw === null) return null;
  // Separators other than `/` never appear in a served path.
  if (raw.includes('\\')) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${RENDERER_SCHEME}:` ||
    parsed.hostname !== RENDERER_SCHEME_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  // The raw and normalized paths must agree: a path the URL parser
  // rewrote (dot segments, encoded dots) is refused, not followed.
  if (parsed.pathname !== raw) return null;
  const encodedSegments = raw.split('/').slice(1);
  if (encodedSegments.length === 0 || encodedSegments.length > MAX_SEGMENTS) {
    return null;
  }
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (!SAFE_SEGMENT.test(decoded)) return null;
    segments.push(decoded);
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '' &&
    !fromRoot.startsWith(`..${sep}`) &&
    fromRoot !== '..' &&
    !isAbsolute(fromRoot)
  );
}

export function createRendererSchemeHandler(
  options: RendererSchemeHandlerOptions,
): (request: RendererSchemeRequest) => Promise<Response> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  let realRoot: Promise<string | null> | null = null;
  const resolveRoot = (): Promise<string | null> => {
    realRoot ??= fileSystem.realpath(options.rootDir).catch(() => {
      // Retry on the next request; an unreadable root serves nothing.
      realRoot = null;
      return null;
    });
    return realRoot;
  };

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }
    const segments = rendererSchemeRequestSegments(request.url);
    if (segments === null) return notFound();

    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (segments.length === 1 && segments[0] === RENDERER_STORAGE_BRIDGE_PAGE) {
      return new Response(method === 'HEAD' ? null : STORAGE_BRIDGE_HTML, {
        status: 200,
        headers: { ...headers, 'Content-Type': HTML_CONTENT_TYPE },
      });
    }

    const root = await resolveRoot();
    if (root === null) return notFound();
    const candidate = join(root, ...segments);
    if (!isInside(root, candidate)) return notFound();

    let target: string;
    try {
      target = await fileSystem.realpath(candidate);
      if (!isInside(root, target)) return notFound();
      if (!(await fileSystem.stat(target)).isFile()) return notFound();
    } catch {
      return notFound();
    }

    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await fileSystem.readFile(target);
    } catch (error) {
      options.onError?.(error);
      return new Response(null, { status: 500, headers });
    }
    return new Response(method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': rendererSchemeContentType(target),
        'Content-Length': String(body.byteLength),
      },
    });
  };
}
