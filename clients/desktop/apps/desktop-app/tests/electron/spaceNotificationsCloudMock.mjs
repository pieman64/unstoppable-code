import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

/**
 * Per-test Canopy Cloud server for the per-space notification choices spec
 * (CAN-3615). It speaks the real wire contract the desktop uses —
 * `POST /api/v1/notification-spaces/producers/<producerId>` to register and
 * read spaces, and `PATCH /api/v1/notification-spaces/<spaceId>` to save —
 * and keeps choices server-authoritative, with revision protection and
 * transitions stamped by this server's clock. Like the real server, it only
 * ever sees the desktop's keyed references to local ids.
 */
const CAPABILITIES = [
  'pipelines-crud-v1',
  'plans-crud-v1',
  'runs-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
  'session-exports-v1',
];

const ACCOUNT = {
  id: 'space-notifications-account-e2e',
  name: 'Space Notifications E2E',
  email: 'space-notifications-e2e@example.test',
  role: 'DEVELOPER',
};

/** Mirrors `spaceNotificationRef` in the desktop's main process. */
function ref(producerId, id) {
  return createHmac('sha256', producerId).update(id).digest('base64url');
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

function isAuthorized(request) {
  return /^Bearer\s+csk_/.test(request.headers.authorization ?? '');
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

export async function startSpaceNotificationsCloudMock() {
  /** spaceId → { workspaceId, sourceSpaceId, revision, override, transitions } */
  const spaces = new Map();
  /** `${workspaceRef}\u001f${sourceSpaceRef}` → spaceId */
  const keys = new Map();
  /** The install id the desktop registered under, and every sync body. */
  let producerId = null;
  const syncBodies = [];
  const requests = [];
  /** Queued faults for the next PATCH: 'fail' (500) or 'conflict' (409). */
  const patchFaults = [];
  /** While set, the next PATCH waits for it before answering. */
  let heldSave = null;

  function snapshot(spaceId) {
    const space = spaces.get(spaceId);
    return {
      spaceId,
      revision: space.revision,
      override: space.override,
      effectiveLevel: space.override ?? 'all',
      writesEnabled: true,
      transitions: space.transitions,
      nextRevision: null,
    };
  }

  function applyChoice(spaceId, override) {
    const space = spaces.get(spaceId);
    space.revision += 1;
    space.transitions.push({
      revision: space.revision,
      effectiveAt: new Date().toISOString(),
      priorOverride: space.override,
      nextOverride: override,
    });
    space.override = override;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method ?? 'GET', pathname: url.pathname });
    try {
      if (request.method === 'GET' && url.pathname === '/.well-known/canopy') {
        sendJson(response, 200, { capabilities: CAPABILITIES });
        return;
      }
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: 'Invalid API key.' });
        return;
      }
      if (
        request.method === 'GET' &&
        (url.pathname === '/api/v1/desktop-app/account' ||
          url.pathname === '/api/v1/canopy/account')
      ) {
        sendJson(response, 200, {
          account: ACCOUNT,
          capabilities: CAPABILITIES,
          organizations: [],
          teams: [],
          enforcedSettings: [],
        });
        return;
      }
      const producer = url.pathname.match(
        /^\/api\/v1\/notification-spaces\/producers\/([^/]+)$/,
      );
      if (request.method === 'POST' && producer) {
        producerId = decodeURIComponent(producer[1]);
        const body = await readJsonBody(request);
        syncBodies.push(JSON.stringify(body));
        const result = [];
        for (const source of body.spaces ?? []) {
          const key = `${source.workspaceId}\u001f${source.spaceId}`;
          let spaceId = keys.get(key);
          if (!spaceId) {
            spaceId = randomUUID();
            keys.set(key, spaceId);
            spaces.set(spaceId, {
              workspaceId: source.workspaceId,
              sourceSpaceId: source.spaceId,
              revision: 0,
              override: null,
              transitions: [],
            });
          }
          result.push({
            workspaceId: source.workspaceId,
            spaceId: source.spaceId,
            policy: snapshot(spaceId),
          });
        }
        sendJson(response, 200, {
          serverTime: new Date().toISOString(),
          transitionsSince: new Date(Date.now() - 86_400_000).toISOString(),
          writesEnabled: true,
          spaces: result,
        });
        return;
      }
      const space = url.pathname.match(
        /^\/api\/v1\/notification-spaces\/([0-9a-f-]{36})$/,
      );
      if (space && spaces.has(space[1])) {
        const spaceId = space[1];
        if (request.method === 'GET') {
          sendJson(response, 200, snapshot(spaceId));
          return;
        }
        if (request.method === 'PATCH') {
          const body = await readJsonBody(request);
          if (heldSave) {
            const hold = heldSave;
            heldSave = null;
            await hold;
          }
          const fault = patchFaults.shift();
          if (fault === 'fail') {
            sendJson(response, 500, { error: 'Injected failure.' });
            return;
          }
          if (fault === 'conflict') {
            // Another device saved Needs my attention first.
            applyChoice(spaceId, 'attention');
          }
          const current = spaces.get(spaceId);
          if (body.expectedRevision !== current.revision) {
            sendJson(response, 409, {
              error: 'Notification preference changed',
              policy: snapshot(spaceId),
            });
            return;
          }
          if (current.override !== body.override)
            applyChoice(spaceId, body.override);
          sendJson(response, 200, snapshot(spaceId));
          return;
        }
      }
      sendJson(response, 404, { error: 'Not found.' });
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
    throw new Error('Space notifications mock did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    /** The saved choice for a local space, or `undefined` before registration. */
    choiceFor(workspaceId, sourceSpaceId) {
      if (producerId === null) return undefined;
      const spaceId = keys.get(
        `${ref(producerId, workspaceId)}\u001f${ref(producerId, sourceSpaceId)}`,
      );
      return spaceId === undefined ? undefined : spaces.get(spaceId).override;
    },
    /** Whether any producer sync carried this local id in clear. */
    sawLocalId(id) {
      return syncBodies.some((body) => body.includes(id));
    },
    failNextSave() {
      patchFaults.push('fail');
    },
    conflictNextSave() {
      patchFaults.push('conflict');
    },
    /** Holds the next save in flight; call the result to let it answer. */
    holdNextSave() {
      let release = () => undefined;
      heldSave = new Promise((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
