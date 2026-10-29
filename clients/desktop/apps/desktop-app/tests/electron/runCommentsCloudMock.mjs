import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Per-test Canopy Cloud server for the shared-run comments Electron spec
 * (CAN-397).
 *
 * It implements the real wire contract the desktop client speaks
 * (`apps/desktop-app/src/main/runs/canopy-server-client.ts`) rather than an
 * app-only shortcut, so the capability probe, the `GET` detail read, and the
 * comment mutations all cross a real HTTP boundary. Comments are
 * server-authoritative in production, and they are here too: every mutation
 * mutates this server's state and returns the full fresh `SharedRunDetail`,
 * exactly as `run-comments.ts` does.
 *
 * `run-comments-v1` is advertised separately from `runs-crud-v1` so the spec
 * exercises the same optional-capability gate a real deployment uses.
 */
const CAPABILITIES = [
  // The desktop REQUIRES these to accept an API key at all; omitting any one of
  // them makes `saveCanopyCloudApiKey` reject the key with
  // "missing required capabilities" and the session stays signed out.
  'pipelines-crud-v1',
  'plans-crud-v1',
  'runs-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
  'session-exports-v1',
  // Optional, and the whole point of this fixture: a server without it must
  // degrade to "no comments" rather than erroring.
  'run-comments-v1',
];

const ACCOUNT = {
  id: 'run-comments-account-e2e',
  name: 'Run Comments E2E',
  email: 'run-comments-e2e@example.test',
  role: 'DEVELOPER',
};

/** External id of the signed-in viewer, mirrored into `viewerUserId`. */
const VIEWER_USER_ID = 'user-viewer-e2e';

const REVIEWER = {
  userId: 'user-reviewer-e2e',
  displayName: 'Riley Reviewer',
  image: null,
};

const VIEWER_AUTHOR = {
  userId: VIEWER_USER_ID,
  displayName: 'Run Comments E2E',
  image: null,
};

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

/**
 * @param {object} [options]
 * @param {string} [options.runExternalId] external id the desktop will request
 * @param {string} [options.seededThreadBody] first reviewer comment on the run
 * @param {object[]} [options.organizations] organizations the account reports
 *   and the share pickers list (see `seeders/shareMembership.mjs`)
 * @param {object[]} [options.teams] teams the account reports and the share
 *   pickers list
 */
export async function startRunCommentsCloudMock(options = {}) {
  const runExternalId = options.runExternalId ?? randomUUID();
  const seededThreadBody =
    options.seededThreadBody ?? 'This tool call looks wrong to me.';
  // Share dialogs offer Team and Organization only to an account that belongs
  // to an organization (and Team only to a team member), so a spec that
  // shares a session passes its membership here. The default is a solo user.
  const organizations = options.organizations ?? [];
  const teams = options.teams ?? [];

  const requests = [];

  /** Server-authoritative comment state for the one seeded run. */
  const state = {
    commentRevision: 3,
    threads: [
      {
        id: 'web:thread-1',
        status: 'open',
        anchor: { kind: 'run' },
        anchorState: 'matched',
        createdAt: '2026-08-11T10:00:00.000Z',
        comments: [
          {
            id: 'web:comment-1',
            author: REVIEWER,
            body: seededThreadBody,
            createdAt: '2026-08-11T10:00:00.000Z',
          },
        ],
      },
    ],
  };

  function detail() {
    return {
      externalId: runExternalId,
      shareScope: 'team',
      title: 'Shared run with comments',
      createdAt: '2026-08-11T09:00:00.000Z',
      updatedAt: '2026-08-11T09:00:00.000Z',
      clientChatId: 'seeded-chat-1',
      summary: 'A seeded run used by the CAN-397 comments spec.',
      transcript: [],
      messages: [],
      diff: '',
      rollup: {
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        durationMs: 1000,
      },
      author: {
        userId: VIEWER_USER_ID,
        displayName: ACCOUNT.name,
        image: null,
      },
      organizationId: null,
      plans: [],
      commentThreads: state.threads,
      commentRevision: state.commentRevision,
      viewerUserId: VIEWER_USER_ID,
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: request.method ?? 'GET',
      pathname: url.pathname,
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
        if (!isAuthorized(request)) {
          sendJson(response, 401, { error: 'Invalid API key.' });
          return;
        }
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
        if (!isAuthorized(request)) {
          sendJson(response, 401, { error: 'Invalid API key.' });
          return;
        }
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

      // The desktop client builds run paths from `BRAND.web.apiNamespace`,
      // which is `desktop-app` for both shipped brands; `canopy` is accepted
      // too so the mock survives a namespace change.
      const runsPrefix = [
        '/api/v1/desktop-app/runs',
        '/api/v1/canopy/runs',
      ].find((candidate) => url.pathname.startsWith(candidate));
      if (!runsPrefix) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: 'Invalid API key.' });
        return;
      }

      const suffix = url.pathname.slice(runsPrefix.length + 1);
      const segments = suffix
        .split('/')
        .map((part) => decodeURIComponent(part));
      // Uniform 404 for an unknown run, matching the server's no-existence-leak
      // rule.
      if (segments[0] !== runExternalId) {
        sendJson(response, 404, { error: 'Run not found' });
        return;
      }

      if (request.method === 'GET' && segments.length === 1) {
        sendJson(response, 200, detail());
        return;
      }

      if (segments[1] !== 'comments') {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }

      // POST …/comments — create a new whole-run or anchored thread.
      if (request.method === 'POST' && segments.length === 2) {
        const body = await readJsonBody(request);
        const createdAt = new Date().toISOString();
        state.threads.push({
          id: `web:${randomUUID()}`,
          status: 'open',
          anchor: body.anchor ?? { kind: 'run' },
          anchorState: 'matched',
          createdAt,
          comments: [
            {
              id: `web:${randomUUID()}`,
              author: VIEWER_AUTHOR,
              body: String(body.body ?? ''),
              createdAt,
            },
          ],
        });
        state.commentRevision += 1;
        sendJson(response, 201, detail());
        return;
      }

      if (segments.length !== 3) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const thread = state.threads.find(
        (candidate) => candidate.id === segments[2],
      );
      if (!thread) {
        sendJson(response, 404, { error: 'Comment thread not found' });
        return;
      }

      // POST …/comments/{threadId} — reply.
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        thread.comments.push({
          id: `web:${randomUUID()}`,
          author: VIEWER_AUTHOR,
          body: String(body.body ?? ''),
          createdAt: new Date().toISOString(),
        });
        state.commentRevision += 1;
        sendJson(response, 201, detail());
        return;
      }

      // PATCH …/comments/{threadId} — open/resolve.
      if (request.method === 'PATCH') {
        const body = await readJsonBody(request);
        thread.status = body.status === 'resolved' ? 'resolved' : 'open';
        state.commentRevision += 1;
        sendJson(response, 200, detail());
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
    throw new Error('Run comments mock did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    runExternalId,
    requests,
    state,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
