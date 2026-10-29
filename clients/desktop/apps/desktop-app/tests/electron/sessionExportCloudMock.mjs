import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const CAPABILITIES = [
  'pipelines-crud-v1',
  'runs-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
  'session-exports-v1',
];

const ACCOUNT = {
  id: 'session-export-account-e2e',
  name: 'Session Export E2E',
  email: 'session-export-e2e@example.test',
  role: 'DEVELOPER',
};

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

function sendNotFound(response) {
  sendJson(response, 404, { error: 'Session export not found.' });
}

function isAuthorized(request) {
  return /^Bearer\s+csk_/.test(request.headers.authorization ?? '');
}

function requireAuthorization(request, response) {
  if (isAuthorized(request)) return true;
  sendJson(response, 401, { error: 'Invalid API key.' });
  return false;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readMultipartUpload(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string') {
    throw new Error('Missing multipart content type.');
  }

  const body = await readRequestBody(request);
  const formData = await new Request('http://127.0.0.1/session-export', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }).formData();
  const metadataPart = formData.get('metadata');
  const bundlePart = formData.get('bundle');
  const metadataText =
    typeof metadataPart === 'string'
      ? metadataPart
      : metadataPart && typeof metadataPart.text === 'function'
        ? await metadataPart.text()
        : null;
  if (metadataText === null) {
    throw new Error('Missing metadata multipart field.');
  }
  if (!bundlePart || typeof bundlePart.arrayBuffer !== 'function') {
    throw new Error('Missing bundle multipart field.');
  }

  return {
    metadata: JSON.parse(metadataText),
    bundle: Buffer.from(await bundlePart.arrayBuffer()),
  };
}

function toRecord(entry) {
  return { ...entry.record };
}

/**
 * Per-test Canopy Cloud server for the session-transfer Electron spec. It
 * intentionally implements the production wire contract rather than exposing
 * app-only shortcuts, so export hashing and archive transport cross the real
 * HTTP/multipart boundary.
 *
 * @param {object} [options]
 * @param {object[]} [options.organizations] organizations the account reports
 *   and the share pickers list (see `seeders/shareMembership.mjs`)
 * @param {object[]} [options.teams] teams the account reports and the share
 *   pickers list
 */
export async function startSessionExportCloudMock(options = {}) {
  // Session share dialogs offer Team and Organization only to an account that
  // belongs to an organization, so a spec that opens one passes its
  // membership here. The default is a solo user.
  const organizations = options.organizations ?? [];
  const teams = options.teams ?? [];
  const exportsById = new Map();
  const uploadAttempts = [];
  const requests = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: request.method ?? 'GET',
      pathname: url.pathname,
      authorization: request.headers.authorization ?? null,
      q: url.searchParams.get('q'),
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
    });

    try {
      if (request.method === 'GET' && url.pathname === '/.well-known/canopy') {
        sendJson(response, 200, { capabilities: CAPABILITIES });
        return;
      }

      if (
        request.method === 'GET' &&
        (url.pathname === '/api/v1/desktop-app/account' ||
          url.pathname === '/api/v1/canopy/account')
      ) {
        if (!requireAuthorization(request, response)) return;
        sendJson(response, 200, {
          account: ACCOUNT,
          capabilities: CAPABILITIES,
          organizations,
          teams,
          enforcedSettings: [],
        });
        return;
      }

      // The share dialog's team and organization pickers list the account's
      // membership, filtered by the picker's `q` search.
      const membershipList = [
        ['/api/v1/desktop-app/teams', teams],
        ['/api/v1/canopy/teams', teams],
        ['/api/v1/desktop-app/organizations', organizations],
        ['/api/v1/canopy/organizations', organizations],
      ].find(([pathname]) => pathname === url.pathname);
      if (request.method === 'GET' && membershipList) {
        if (!requireAuthorization(request, response)) return;
        const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const targets = membershipList[1];
        sendJson(response, 200, {
          data: query
            ? targets.filter((target) =>
                target.name.toLowerCase().includes(query),
              )
            : targets,
          nextCursor: null,
        });
        return;
      }

      const collectionPath = '/api/v1/canopy/session-exports';
      if (!url.pathname.startsWith(collectionPath)) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (!requireAuthorization(request, response)) return;

      if (request.method === 'POST' && url.pathname === collectionPath) {
        let upload;
        try {
          upload = await readMultipartUpload(request);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const computedHash = createHash('sha256')
          .update(upload.bundle)
          .digest('hex');
        const hasGzipMagic =
          upload.bundle.length >= 2 &&
          upload.bundle[0] === 0x1f &&
          upload.bundle[1] === 0x8b;
        const hashMatches = computedHash === upload.metadata?.contentHash;
        const attempt = {
          metadata: upload.metadata,
          bundle: upload.bundle,
          computedHash,
          hasGzipMagic,
          hashMatches,
        };
        uploadAttempts.push(attempt);

        if (!hasGzipMagic) {
          sendJson(response, 400, { error: 'Bundle must be gzip encoded.' });
          return;
        }
        if (!hashMatches) {
          sendJson(response, 400, { error: 'Bundle hash does not match.' });
          return;
        }

        const timestamp = new Date().toISOString();
        const id = randomUUID();
        const record = {
          ...upload.metadata,
          id,
          sizeBytes: upload.bundle.length,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        exportsById.set(id, {
          record,
          bundle: upload.bundle,
        });
        attempt.record = record;
        sendJson(response, 201, record);
        return;
      }

      if (request.method === 'GET' && url.pathname === collectionPath) {
        const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const cursor = url.searchParams.get('cursor');
        const requestedLimit = Number.parseInt(
          url.searchParams.get('limit') ?? '',
          10,
        );
        const limit =
          Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, 100)
            : 25;
        const data = [...exportsById.values()]
          .map(toRecord)
          .filter(
            (record) =>
              query.length === 0 || record.title.toLowerCase().includes(query),
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const cursorIndex = cursor
          ? data.findIndex((record) => record.id === cursor)
          : -1;
        if (cursor && cursorIndex < 0) {
          sendJson(response, 400, { error: 'Invalid pagination cursor.' });
          return;
        }
        const pageStart = cursorIndex + 1;
        const page = data.slice(pageStart, pageStart + limit);
        const nextCursor =
          pageStart + page.length < data.length
            ? (page[page.length - 1]?.id ?? null)
            : null;
        sendJson(response, 200, { data: page, nextCursor });
        return;
      }

      const suffix = url.pathname.slice(collectionPath.length + 1);
      const bundleMatch = /^([^/]+)\/bundle$/.exec(suffix);
      if (request.method === 'GET' && bundleMatch) {
        const entry = exportsById.get(bundleMatch[1]);
        if (!entry) {
          sendNotFound(response);
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': String(entry.bundle.length),
          etag: `"${entry.record.contentHash}"`,
          'cache-control': 'private, no-store',
        });
        response.end(entry.bundle);
        return;
      }

      if (request.method === 'GET' && suffix && !suffix.includes('/')) {
        const entry = exportsById.get(suffix);
        if (!entry) {
          sendNotFound(response);
          return;
        }
        sendJson(response, 200, toRecord(entry));
        return;
      }

      if (request.method === 'DELETE' && suffix && !suffix.includes('/')) {
        if (!exportsById.delete(suffix)) {
          sendNotFound(response);
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }

      sendJson(response, 405, { error: 'Method not allowed.' });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Session export mock did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    exportsById,
    requests,
    uploadAttempts,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
