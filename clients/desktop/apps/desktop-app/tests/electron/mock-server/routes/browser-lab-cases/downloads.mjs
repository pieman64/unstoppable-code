import { Buffer } from 'node:buffer';

const ENTRY_PATH = '/browser-lab/downloads';
const DOWNLOAD_PREFIX = '/browser-lab/download/';
const LARGE_ETAG = '"browser-lab-large-1"';
const INTERRUPTED_ETAG = '"browser-lab-interrupted-1"';
const LAST_MODIFIED = 'Wed, 01 Oct 2025 00:00:00 GMT';
/** How long a resetting stream waits after its last byte before the reset. */
const RESET_DELAY_MS = 1_500;
const LARGE_SEED = 'Browser Lab large download synthetic bytes';
const INTERRUPTED_SEED = 'Browser Lab interrupted download synthetic bytes';
const BLOB_TEXT = 'Browser Lab blob download\n';
const DATA_URL_TEXT = 'Browser Lab data URL download\n';
const LONG_FILE_NAME = `browser-lab-long-${'a'.repeat(279)}.txt`;
const UNICODE_FILE_NAME = 'Résumé – 東京 ✓.txt';
const BIDI_FILE_NAME = 'browser-lab-\u202etxt.exe';
const NUL_FILE_NAME = 'file.txt\u0000.exe';

const PDF_BODY = createPdf();
const DATA_URL = `data:text/plain;charset=utf-8;base64,${Buffer.from(DATA_URL_TEXT, 'utf8').toString('base64')}`;
const LOOP_BODY = 'Browser Lab loop download 1\n';

const VARIANTS = [
  {
    variant: 'attachment',
    fileName: 'browser-lab-report.txt',
    disposition: 'attachment; filename="browser-lab-report.txt"',
    contentType: 'text/plain',
    body: 'Browser Lab attachment report\n',
  },
  {
    variant: 'same-name-a',
    fileName: 'browser-lab-duplicate.txt',
    disposition: 'attachment; filename="browser-lab-duplicate.txt"',
    contentType: 'text/plain',
    body: 'Browser Lab duplicate A\n',
  },
  {
    variant: 'same-name-b',
    fileName: 'browser-lab-duplicate.txt',
    disposition: 'attachment; filename="browser-lab-duplicate.txt"',
    contentType: 'text/plain',
    body: 'Browser Lab duplicate B\n',
  },
  {
    variant: 'large',
    fileName: 'browser-lab-large.bin',
    disposition: 'attachment; filename="browser-lab-large.bin"',
    contentType: 'application/octet-stream',
    bytes: { limit: 'downloadLargeBytes' },
  },
  {
    variant: 'interrupted',
    fileName: 'browser-lab-interrupted.bin',
    disposition: 'attachment; filename="browser-lab-interrupted.bin"',
    contentType: 'application/octet-stream',
    bytes: { limit: 'downloadInterruptedBytes' },
    interruptAfterBytes: { limit: 'downloadInterruptAfterBytes' },
  },
  {
    variant: 'hostile-unix-traversal',
    fileName: '../../etc/passwd',
    disposition: 'attachment; filename="../../etc/passwd"',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic Unix traversal name\n',
  },
  {
    variant: 'hostile-windows-traversal',
    fileName: '..\\..\\Windows\\x.txt',
    disposition: 'attachment; filename="..\\..\\Windows\\x.txt"',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic Windows traversal name\n',
  },
  {
    variant: 'hostile-nul',
    fileName: NUL_FILE_NAME,
    disposition:
      'attachment; filename="file.txt_.exe"; filename*=UTF-8\'\'file.txt%00.exe',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic NUL filename\n',
  },
  {
    variant: 'hostile-reserved',
    fileName: 'CON.txt',
    disposition: 'attachment; filename="CON.txt"',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic reserved filename\n',
  },
  {
    variant: 'hostile-trailing-dots',
    fileName: 'browser-lab-trailing.txt...',
    disposition: 'attachment; filename="browser-lab-trailing.txt..."',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic trailing dots filename\n',
  },
  {
    variant: 'hostile-long',
    fileName: LONG_FILE_NAME,
    disposition: `attachment; filename="${LONG_FILE_NAME}"`,
    contentType: 'text/plain',
    body: 'Browser Lab synthetic long filename\n',
  },
  {
    variant: 'hostile-unicode',
    fileName: UNICODE_FILE_NAME,
    disposition:
      'attachment; filename="browser-lab-unicode.txt"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9%20%E2%80%93%20%E6%9D%B1%E4%BA%AC%20%E2%9C%93.txt',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic Unicode filename\n',
  },
  {
    variant: 'hostile-bidi',
    fileName: BIDI_FILE_NAME,
    disposition:
      'attachment; filename="browser-lab-bidi.txt"; filename*=UTF-8\'\'browser-lab-%E2%80%AEtxt.exe',
    contentType: 'text/plain',
    body: 'Browser Lab synthetic bidi filename\n',
  },
  {
    variant: 'executable',
    fileName: 'browser-lab-setup.exe',
    disposition: 'attachment; filename="browser-lab-setup.exe"',
    contentType: 'application/octet-stream',
    body: 'Browser Lab synthetic executable-named text; not executable.\n',
  },
  {
    variant: 'loop',
    fileName: 'browser-lab-loop-1.txt',
    disposition: 'attachment; filename="browser-lab-loop-1.txt"',
    contentType: 'text/plain',
    body: LOOP_BODY,
  },
  {
    variant: 'pdf',
    fileName: 'browser-lab-document.pdf',
    disposition: 'inline; filename="browser-lab-document.pdf"',
    contentType: 'application/pdf',
    bytes: PDF_BODY.length,
  },
  {
    variant: 'pdf-attachment',
    fileName: 'browser-lab-document.pdf',
    disposition: 'attachment; filename="browser-lab-document.pdf"',
    contentType: 'application/pdf',
    bytes: PDF_BODY.length,
  },
].map((variant) => ({
  ...variant,
  path: `${DOWNLOAD_PREFIX}${variant.variant}`,
  ...(variant.body !== undefined
    ? { bytes: Buffer.byteLength(variant.body, 'utf8') }
    : {}),
}));

const DOWNLOAD_SCRIPT = `(() => {
  'use strict';
  const link = document.querySelector('[data-testid="browser-lab-downloads-blob"]');
  if (!link) return;
  const blob = new Blob(['${BLOB_TEXT.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'], { type: 'text/plain' });
  link.href = URL.createObjectURL(blob);
})();`;

export const interactionCase = {
  id: 'downloads',
  kind: 'interaction',
  title: 'Downloads',
  entryPath: ENTRY_PATH,
  pages: [
    {
      path: ENTRY_PATH,
      controls: [
        'browser-lab-downloads-main',
        ...VARIANTS.map(({ variant }) => `browser-lab-downloads-${variant}`),
        'browser-lab-downloads-blob',
        'browser-lab-downloads-data-url',
        'browser-lab-downloads-pdf-view',
      ],
    },
  ],
  endpoints: VARIANTS.map(({ path }) => path),
  downloads: VARIANTS.map(
    ({
      variant,
      path,
      fileName,
      disposition,
      contentType,
      bytes,
      interruptAfterBytes,
    }) => ({
      variant,
      path,
      fileName,
      disposition,
      contentType,
      bytes,
      ...(interruptAfterBytes ? { interruptAfterBytes } : {}),
    }),
  ),
  browserGeneratedDownloads: [
    {
      variant: 'blob',
      fileName: 'browser-lab-blob.txt',
      contentType: 'text/plain',
      body: BLOB_TEXT,
    },
    {
      variant: 'data-url',
      fileName: 'browser-lab-data-url.txt',
      contentType: 'text/plain',
      body: DATA_URL_TEXT,
    },
  ],
};

function createPdf() {
  const stream = 'BT /F1 24 Tf 72 720 Td (Browser Lab PDF) Tj ET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream\nendobj\n`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(document, 'ascii'));
    document += object;
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'ascii');
}

function byteAt(offset, seed) {
  return seed.charCodeAt(offset % seed.length);
}

function syntheticRange(offset, length, seed) {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = byteAt(offset + index, seed);
  }
  return bytes;
}

function rfc5987(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDispositionForFileName(dispositionType, fileName, fallback) {
  const safeAscii = /^[\x20-\x7e]+$/.test(fileName) && !/["\\]/.test(fileName);
  if (safeAscii) return `${dispositionType}; filename="${fileName}"`;
  return `${dispositionType}; filename="${fallback}"; filename*=UTF-8''${rfc5987(fileName)}`;
}

function rangeForRequest(request, totalBytes, etag) {
  const rawRange = request.headers.range;
  if (typeof rawRange !== 'string')
    return { status: 200, start: 0, end: totalBytes };
  if (
    request.headers['if-range'] !== undefined &&
    request.headers['if-range'] !== etag
  ) {
    return { status: 200, start: 0, end: totalBytes };
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(rawRange.trim());
  if (!match) return { error: true };
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= totalBytes)
    return { error: true };
  const requestedEnd = match[2] === '' ? totalBytes - 1 : Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start)
    return { error: true };
  return { status: 206, start, end: Math.min(totalBytes, requestedEnd + 1) };
}

function baseHeaders(kit, variant, contentLength) {
  const headers = {
    ...kit.COMMON_HEADERS,
    'content-type': variant.contentType,
    'content-length': String(contentLength),
    'content-disposition': variant.disposition,
  };
  if (variant.contentType !== 'application/pdf') {
    headers['content-security-policy'] = "default-src 'none'; sandbox";
  }
  return headers;
}

function sendSmallDownload(context, kit, variant, body) {
  const headers = baseHeaders(kit, variant, body.length);
  context.response.writeHead(200, headers);
  if (context.request.method === 'HEAD') context.response.end();
  else context.response.end(body);
}

function sendRangeError(context, kit, variant, totalBytes, etag, lastModified) {
  const headers = {
    ...baseHeaders(kit, variant, 0),
    'accept-ranges': 'bytes',
    etag,
    'last-modified': lastModified,
    'content-range': `bytes */${totalBytes}`,
  };
  context.response.writeHead(416, headers);
  context.response.end();
}

function streamSynthetic(context, kit, variant, limits, options) {
  const {
    totalBytes,
    etag,
    seed,
    interrupt = false,
    reset = false,
    stallAt,
    isReleased,
  } = options;
  const range = rangeForRequest(context.request, totalBytes, etag);
  if (range.error)
    return sendRangeError(
      context,
      kit,
      variant,
      totalBytes,
      etag,
      LAST_MODIFIED,
    );
  const { start, end, status } = range;
  const length = end - start;
  const headers = {
    ...baseHeaders(kit, variant, length),
    'accept-ranges': 'bytes',
    etag,
    'last-modified': LAST_MODIFIED,
  };
  if (status === 206)
    headers['content-range'] = `bytes ${start}-${end - 1}/${totalBytes}`;
  let release = null;
  if (context.request.method !== 'HEAD') {
    release = kit.acquireStreamSlot(context);
    if (!release) {
      return kit.sendRouteError(
        context,
        503,
        'Too many streamed downloads are active. Try again shortly.',
        {
          'retry-after': '1',
        },
      );
    }
  }
  context.response.writeHead(status, headers);
  if (context.request.method === 'HEAD') {
    context.response.end();
    return;
  }
  let cursor = start;
  let timer = null;
  let closed = false;
  const onClose = () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
  };
  context.response.once('close', onClose);
  const interruptEnd =
    interrupt && status === 200 ? limits.downloadInterruptAfterBytes : end;
  const sendChunk = () => {
    if (closed || context.response.destroyed) return;
    // A stalled stream trickles one byte a tick past `stallAt` until
    // `isReleased()` turns true. The trickle keeps the browser reading, so it
    // reports the bytes it already has.
    const stalled = stallAt !== undefined && cursor >= stallAt && !isReleased();
    const nextEnd = Math.min(
      cursor + (stalled ? 1 : limits.downloadChunkBytes),
      end,
      interruptEnd,
    );
    const chunk = syntheticRange(cursor, nextEnd - cursor, seed);
    cursor = nextEnd;
    try {
      if (interrupt && status === 200 && cursor >= interruptEnd) {
        context.response.write(chunk, () => {
          if (closed) return;
          // A reset is a network failure the browser leaves for the user to
          // resume; a plain close is a short body it resumes by itself.
          if (!reset) {
            context.response.destroy();
            return;
          }
          // The browser holds a new download paused while it admits it; a
          // reset that arrives during that hold can go unreported, leaving
          // the download progressing with no bytes. Reset only after the
          // bytes have had time to be read.
          timer = setTimeout(() => {
            if (!closed) resetConnection(context);
          }, RESET_DELAY_MS);
        });
        return;
      }
      if (cursor >= end) {
        context.response.end(chunk);
        return;
      }
      context.response.write(chunk);
      timer = setTimeout(sendChunk, limits.downloadChunkIntervalMs);
    } catch {
      context.response.destroy();
    }
  };
  if (context.response.destroyed) {
    release();
    return;
  }
  sendChunk();
}

function resetConnection(context) {
  const socket = context.response.socket ?? context.request.socket;
  if (socket && typeof socket.resetAndDestroy === 'function')
    socket.resetAndDestroy();
  else context.response.destroy();
}

// Electron flow extras (browser-files.spec.mjs). They stay out of the case
// catalog, whose variants all answer a plain GET with their full length.
//
// `resumable` drops its first response with a connection reset after
// `downloadInterruptAfterBytes`, which the browser reports as a resumable
// interruption. While its `hold` token is held, every ranged retry is reset
// too, so an automatic resume cannot finish it before the user does. A GET
// of `resumable-release?hold=<token>` lets later ranged requests through.
const RESUMABLE_PATH = `${DOWNLOAD_PREFIX}resumable`;
const RESUMABLE_RELEASE_PATH = `${DOWNLOAD_PREFIX}resumable-release`;
const RESUMABLE_ETAG = '"browser-lab-resumable-1"';
const RESUMABLE_SEED = 'Browser Lab resumable download synthetic bytes';
const RESUMABLE_VARIANT = {
  variant: 'resumable',
  fileName: 'browser-lab-resumable.bin',
  disposition: 'attachment; filename="browser-lab-resumable.bin"',
  contentType: 'application/octet-stream',
};
// `resumable?hold=<token>&stall=1` instead slows to a trickle after
// `downloadInterruptAfterBytes` and sends the rest once the token is released:
// a download that stays in progress for as long as a test needs.
const STALLED_ETAG = '"browser-lab-stalled-1"';
const STALLED_VARIANT = {
  ...RESUMABLE_VARIANT,
  fileName: 'browser-lab-stalled.bin',
  disposition: 'attachment; filename="browser-lab-stalled.bin"',
};
const releasedHolds = new Set();

function holdToken(context, kit, allowed = ['hold']) {
  const parameters = [...context.url.searchParams];
  if (parameters.some(([name]) => !allowed.includes(name))) {
    kit.sendRouteError(
      context,
      400,
      `Use only the ${allowed.join(' and ')} parameters.`,
    );
    return undefined;
  }
  const token = context.url.searchParams.get('hold') ?? '';
  if (!/^[A-Za-z0-9-]{0,64}$/.test(token)) {
    kit.sendRouteError(context, 400, 'The hold token is not valid.');
    return undefined;
  }
  return token;
}

function resumableRoutes(kit, limits) {
  return [
    [
      RESUMABLE_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const token = holdToken(context, kit, ['hold', 'stall']);
            if (token === undefined) return;
            if (context.url.searchParams.get('stall') === '1') {
              if (!token)
                return kit.sendRouteError(context, 400, 'Name a hold token.');
              streamSynthetic(context, kit, STALLED_VARIANT, limits, {
                totalBytes: limits.downloadInterruptedBytes,
                etag: STALLED_ETAG,
                seed: RESUMABLE_SEED,
                stallAt: limits.downloadInterruptAfterBytes,
                isReleased: () => releasedHolds.has(token),
              });
              return;
            }
            const ranged = typeof context.request.headers.range === 'string';
            if (ranged && token && !releasedHolds.has(token)) {
              resetConnection(context);
              return;
            }
            streamSynthetic(context, kit, RESUMABLE_VARIANT, limits, {
              totalBytes: limits.downloadInterruptedBytes,
              etag: RESUMABLE_ETAG,
              seed: RESUMABLE_SEED,
              interrupt: true,
              reset: true,
            });
          },
        },
      },
    ],
    [
      RESUMABLE_RELEASE_PATH,
      {
        kind: 'html',
        methods: {
          GET: (context) => {
            const token = holdToken(context, kit);
            if (token === undefined) return;
            if (!token)
              return kit.sendRouteError(context, 400, 'Name a hold token.');
            releasedHolds.add(token);
            kit.sendPlainText(context.response, 200, 'released');
          },
        },
      },
    ],
  ];
}

function renderDownloadsPage(kit) {
  const { html } = kit;
  return kit.renderInteractionPage({
    caseDef: interactionCase,
    scripts: [DOWNLOAD_SCRIPT],
    main: html`<main data-testid="browser-lab-downloads-main">
      <h1>${interactionCase.title}</h1>
      <p>Generated files for deterministic download tests.</p>
      <ul>
        ${VARIANTS.map(
          ({ variant, path, fileName }) =>
            html`<li>
              <a href="${path}" data-testid="browser-lab-downloads-${variant}"
                >${variant}: ${fileName}</a
              >
            </li>`,
        )}
        <li>
          <a
            href="#"
            download="browser-lab-blob.txt"
            data-testid="browser-lab-downloads-blob"
            >Blob download</a
          >
        </li>
        <li>
          <a
            href="${DATA_URL}"
            download="browser-lab-data-url.txt"
            data-testid="browser-lab-downloads-data-url"
            >Data URL download</a
          >
        </li>
        <li>
          <a
            href="${DOWNLOAD_PREFIX}pdf"
            data-testid="browser-lab-downloads-pdf-view"
            >View the inline PDF</a
          >
        </li>
      </ul>
    </main>`,
  });
}

function findVariant(variant) {
  return VARIANTS.find((item) => item.variant === variant);
}

function sendVariant(context, kit, limits, variant) {
  if (variant.variant === 'large' || variant.variant === 'interrupted') {
    const isInterrupted = variant.variant === 'interrupted';
    streamSynthetic(context, kit, variant, limits, {
      totalBytes: isInterrupted
        ? limits.downloadInterruptedBytes
        : limits.downloadLargeBytes,
      etag: isInterrupted ? INTERRUPTED_ETAG : LARGE_ETAG,
      seed: isInterrupted ? INTERRUPTED_SEED : LARGE_SEED,
      interrupt: isInterrupted,
    });
    return;
  }
  if (variant.variant === 'pdf' || variant.variant === 'pdf-attachment') {
    sendSmallDownload(context, kit, variant, PDF_BODY);
    return;
  }
  sendSmallDownload(context, kit, variant, Buffer.from(variant.body, 'utf8'));
}

function loopRoute(kit, limits) {
  return {
    kind: 'html',
    methods: {
      GET: (context) => {
        const parameters = [...context.url.searchParams];
        if (parameters.some(([name]) => name !== 'n')) {
          return kit.sendRouteError(
            context,
            400,
            'Use only the n download parameter.',
          );
        }
        const rawCount = context.url.searchParams.get('n');
        const count =
          rawCount === null
            ? 1
            : /^[1-9][0-9]*$/.test(rawCount)
              ? Number(rawCount)
              : NaN;
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > limits.hostileDownloadLoopCount
        ) {
          return kit.sendRouteError(
            context,
            400,
            'The loop download count is out of range.',
          );
        }
        const fileName = `browser-lab-loop-${count}.txt`;
        const variant = {
          ...findVariant('loop'),
          fileName,
          disposition: contentDispositionForFileName(
            'attachment',
            fileName,
            fileName,
          ),
          body: `Browser Lab loop download ${count}\n`,
        };
        sendSmallDownload(
          context,
          kit,
          variant,
          Buffer.from(variant.body, 'utf8'),
        );
      },
    },
  };
}

// `named?name=<key>` serves a small attachment under one of a few fixed
// names, so a case can choose how two downloads' names relate.
const NAMED_DOWNLOADS = {
  collide: 'browser-lab-collide.txt',
  'collide-partial': 'browser-lab-collide.txt.download',
};

function namedRoute(kit) {
  return {
    kind: 'html',
    methods: {
      GET: (context) => {
        const parameters = [...context.url.searchParams];
        const key = context.url.searchParams.get('name') ?? '';
        if (
          parameters.some(([name]) => name !== 'name') ||
          !Object.hasOwn(NAMED_DOWNLOADS, key)
        ) {
          return kit.sendRouteError(
            context,
            400,
            `Name one of: ${Object.keys(NAMED_DOWNLOADS).join(', ')}.`,
          );
        }
        const fileName = NAMED_DOWNLOADS[key];
        const variant = {
          ...findVariant('attachment'),
          fileName,
          disposition: contentDispositionForFileName(
            'attachment',
            fileName,
            fileName,
          ),
          body: `Browser Lab named download ${key}\n`,
        };
        sendSmallDownload(
          context,
          kit,
          variant,
          Buffer.from(variant.body, 'utf8'),
        );
      },
    },
  };
}

export function createRoutes(kit) {
  const limits = kit.INTERACTION_LIMITS;
  const routes = [[ENTRY_PATH, kit.pageRoute(() => renderDownloadsPage(kit))]];
  for (const variant of VARIANTS) {
    if (variant.variant === 'loop') continue;
    routes.push([
      variant.path,
      {
        kind: 'html',
        methods: {
          GET: (context) => sendVariant(context, kit, limits, variant),
        },
      },
    ]);
  }
  routes.push([`${DOWNLOAD_PREFIX}loop`, loopRoute(kit, limits)]);
  routes.push(...resumableRoutes(kit, limits));
  routes.push([`${DOWNLOAD_PREFIX}named`, namedRoute(kit)]);
  return routes;
}
