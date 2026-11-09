// Personal cloud project identity surface (CAN-5190).
//
// Serves the routes the desktop cloud project binding calls, so Electron
// specs drive linking through the real IPC, binding engine, Cloud client and
// `workspace.json` writer:
//
//   POST /api/v1/projects/personal/match           → match decision
//   GET  /api/v1/projects/personal?deviceId=       → this device's list (CAN-5192)
//   POST /api/v1/projects/personal                 → create (by creationKey)
//   GET  /api/v1/projects/:id/manifest             → manifest
//   PUT  /api/v1/projects/:id/manifest             → compare-and-set update
//   GET  /api/v1/projects/:id/events?after=        → lifecycle events page
//                                                    (opaque cursors; no
//                                                    `after` reads from the
//                                                    first event)
//   POST /api/v1/projects/:id/instances/claim      → claim this device
//   POST /api/v1/projects/instances/:id/complete   → mark the claim ready
//   POST /api/v1/projects/instances/:id/detach     → release a device setup
//   GET  /api/v1/projects/instances/:id/repositories
//   PUT  /api/v1/projects/instances/:id/repositories
//
// Wire shapes: `packages/protocol/src/memory-sync/projects.ts`. Only keys
// whose scenario has a `cloudProjects` slice are served; other keys fall
// through to `routes/cloud.mjs`, so organization claims keep their own route.
// State lives on the registered scenario (`scenario.cloudProjects`):
//
//   { projects: [manifest, ...], instances: [], events: { [projectId]: [] } }
//
// Deliberate differences from the web service: matching compares remote keys
// only (no provider repository ids, no redirects), and a claim never expires.

import { randomUUID } from 'node:crypto';
import {
  getScenario,
  keyFromBearer,
  recordScenarioActivity,
} from '../control-plane.mjs';

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

function manifestOf(project) {
  return {
    projectId: project.projectId,
    revision: project.revision,
    name: project.name,
    kind: project.kind,
    topology: project.topology,
    repoListSource: project.repoListSource,
    rootRepositoryId: project.rootRepositoryId,
    repositories: project.repositories,
    portableConfig: project.portableConfig,
  };
}

/** Applies repository drafts the way the web service keeps repository ids. */
function applyDrafts(project, drafts) {
  const repositories = drafts.map((draft, ordinal) => ({
    repositoryId: draft.repositoryId ?? randomUUID(),
    sourceKey: draft.sourceKey,
    fingerprint: draft.fingerprint,
    defaultBranch: draft.defaultBranch,
    directoryName: draft.directoryName,
    ordinal,
  }));
  const rootIndex = drafts.findIndex((draft) => draft.root);
  project.repositories = repositories;
  project.rootRepositoryId =
    rootIndex === -1 ? null : repositories[rootIndex].repositoryId;
}

function remoteKeys(request) {
  return [
    ...(request?.rootFingerprint ? [request.rootFingerprint] : []),
    ...(request?.repositories ?? []),
  ].map((fingerprint) => fingerprint.remoteKey);
}

function match(state, request) {
  const keys = remoteKeys(request);
  const candidates = state.projects
    .map((project) => ({
      project,
      matched: project.repositories.filter((repository) =>
        keys.includes(repository.fingerprint.remoteKey),
      ).length,
    }))
    .filter((candidate) => candidate.matched > 0);
  if (candidates.length === 0) return { decision: 'none' };
  const [sole] = candidates;
  if (
    request.topology === 'single_repo' &&
    candidates.length === 1 &&
    sole.project.topology === 'single_repo'
  )
    return {
      decision: 'matched',
      projectId: sole.project.projectId,
      manifestRevision: sole.project.revision,
    };
  return {
    decision: 'candidates',
    candidates: candidates.map(({ project, matched }) => ({
      projectId: project.projectId,
      name: project.name,
      ownerType: 'user',
      organizationId: null,
      matchedRepositories: matched,
      totalRepositories: project.repositories.length,
    })),
  };
}

// The wire format of `formatCloudProjectEventCursor` and
// `parseCloudProjectEventCursor` in @canopy/protocol/memory-sync, which plain
// Node cannot load here (its sources use extensionless imports).
function formatCloudProjectEventCursor({ projectId, seq }) {
  return `pe1.${projectId}.${seq}`;
}

function parseCloudProjectEventCursor(value) {
  const [prefix, projectId, seqText, ...rest] = value.split('.');
  if (prefix !== 'pe1' || rest.length > 0 || !projectId) return null;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(seqText ?? '')) return null;
  return { projectId, seq: Number(seqText) };
}

function feedOf(state, projectId) {
  return state.events?.[projectId] ?? [];
}

/** Where a project's feed stands, as claims answer it. */
function feedEnd(state, projectId) {
  return formatCloudProjectEventCursor({
    projectId,
    seq: feedOf(state, projectId).length,
  });
}

/**
 * One page after `after` (null: from the first event), or null for a cursor
 * the service answers `400 invalid_cursor`: another project's, or one ahead
 * of the feed.
 */
function eventsPage(state, projectId, after) {
  const feed = feedOf(state, projectId);
  const position = after === null ? null : parseCloudProjectEventCursor(after);
  if (
    after !== null &&
    (position === null ||
      position.projectId !== projectId ||
      position.seq > feed.length)
  )
    return null;
  const afterSeq = position?.seq ?? 0;
  const events = feed.slice(afterSeq).map((event, index) => {
    const seq = afterSeq + index + 1;
    return {
      eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      cursor: formatCloudProjectEventCursor({ projectId, seq }),
      event,
    };
  });
  return {
    projectId,
    events,
    nextCursor: formatCloudProjectEventCursor({
      projectId,
      seq: afterSeq + events.length,
    }),
    hasMore: false,
  };
}

const MANIFEST = /^\/api\/v1\/projects\/([^/]+)\/manifest$/;
const EVENTS = /^\/api\/v1\/projects\/([^/]+)\/events$/;
const CLAIM = /^\/api\/v1\/projects\/([^/]+)\/instances\/claim$/;
const COMPLETE = /^\/api\/v1\/projects\/instances\/([^/]+)\/complete$/;
const DETACH = /^\/api\/v1\/projects\/instances\/([^/]+)\/detach$/;
const SELECTION = /^\/api\/v1\/projects\/instances\/([^/]+)\/repositories$/;

/**
 * Handle a cloud project identity request. Returns `true` when it answered,
 * `false` to let the next surface try.
 */
export async function handleCloudProjectsRequest(request, response, url) {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/v1/projects/')) return false;
  const key = keyFromBearer(request);
  if (!key) return false;
  const state = getScenario(key).cloudProjects;
  if (!state) return false;
  state.projects ??= [];
  state.instances ??= [];
  const method = request.method;
  const record = (field) => recordScenarioActivity(key, field);
  const project = (projectId) =>
    state.projects.find((candidate) => candidate.projectId === projectId);

  if (method === 'POST' && pathname === '/api/v1/projects/personal/match') {
    record('cloudProjectMatch');
    jsonResponse(response, 200, match(state, await readJsonBody(request)));
    return true;
  }
  if (method === 'GET' && pathname === '/api/v1/projects/personal') {
    const deviceId = url.searchParams.get('deviceId');
    const generation = Number(url.searchParams.get('installationGeneration'));
    record('cloudProjectList');
    jsonResponse(response, 200, {
      projects: state.projects.map((project) => {
        const instance = state.instances.find(
          (candidate) =>
            candidate.projectId === project.projectId &&
            candidate.deviceId === deviceId &&
            candidate.installationGeneration === generation &&
            candidate.state !== 'DETACHED',
        );
        return {
          projectId: project.projectId,
          name: project.name,
          kind: project.kind,
          topology: project.topology,
          repositoryCount: project.repositories.length,
          updatedAt: '2026-11-03T10:00:00.000Z',
          instance: instance
            ? {
                instanceId: instance.instanceId,
                state: instance.state,
                selectedRepositoryIds: instance.selectedRepositoryIds,
                dismissedRepositoryIds: instance.dismissedRepositoryIds,
              }
            : null,
        };
      }),
    });
    return true;
  }
  if (method === 'POST' && pathname === '/api/v1/projects/personal') {
    const body = await readJsonBody(request);
    record('cloudProjectCreate');
    let created = state.projects.find(
      (candidate) => candidate.creationKey === body.creationKey,
    );
    if (!created) {
      created = {
        projectId: randomUUID(),
        creationKey: body.creationKey,
        revision: 1,
        name: body.name,
        kind: body.kind,
        topology: body.topology,
        repoListSource: body.repoListSource,
        portableConfig: body.portableConfig,
      };
      applyDrafts(created, body.repositories);
      state.projects.push(created);
    }
    jsonResponse(response, 200, manifestOf(created));
    return true;
  }

  const manifestMatch = pathname.match(MANIFEST);
  if (manifestMatch) {
    const target = project(manifestMatch[1]);
    if (!target) return false;
    if (method === 'GET') {
      jsonResponse(response, 200, manifestOf(target));
      return true;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      record(`cloudProjectManifestUpdate:${target.projectId}`);
      if (body.baseRevision !== target.revision) {
        jsonResponse(response, 409, {
          error: 'The project changed',
          code: 'conflict',
        });
        return true;
      }
      target.name = body.name;
      target.topology = body.topology;
      target.repoListSource = body.repoListSource;
      target.portableConfig = body.portableConfig;
      applyDrafts(target, body.repositories);
      target.revision += 1;
      jsonResponse(response, 200, manifestOf(target));
      return true;
    }
  }

  const eventsMatch = pathname.match(EVENTS);
  if (method === 'GET' && eventsMatch && project(eventsMatch[1])) {
    const page = eventsPage(
      state,
      eventsMatch[1],
      url.searchParams.get('after'),
    );
    if (page === null)
      jsonResponse(response, 400, {
        error: 'The event cursor is not a position in this project',
        code: 'invalid_cursor',
      });
    else jsonResponse(response, 200, page);
    return true;
  }

  const claimMatch = pathname.match(CLAIM);
  if (method === 'POST' && claimMatch && project(claimMatch[1])) {
    const body = await readJsonBody(request);
    record(`cloudProjectClaim:${claimMatch[1]}`);
    let instance = state.instances.find(
      (candidate) =>
        candidate.projectId === claimMatch[1] &&
        candidate.deviceId === body.deviceId &&
        candidate.installationGeneration === body.installationGeneration &&
        candidate.state !== 'DETACHED',
    );
    if (instance && instance.localWorkspaceId !== body.localWorkspaceId) {
      jsonResponse(response, 409, {
        error: 'This device already has a different active setup',
        code: 'conflict',
      });
      return true;
    }
    if (!instance) {
      instance = {
        instanceId: randomUUID(),
        operationId: randomUUID(),
        fencingGeneration: 1,
        state: 'CLAIMED',
        projectId: claimMatch[1],
        deviceId: body.deviceId,
        installationGeneration: body.installationGeneration,
        localWorkspaceId: body.localWorkspaceId,
        revision: 1,
        selectedRepositoryIds: [],
        dismissedRepositoryIds: [],
      };
      state.instances.push(instance);
    }
    jsonResponse(response, 200, {
      instanceId: instance.instanceId,
      operationId: instance.operationId,
      fencingGeneration: instance.fencingGeneration,
      state: instance.state,
      eventsCursor: feedEnd(state, claimMatch[1]),
    });
    return true;
  }

  const instance = (instanceId) =>
    state.instances.find((candidate) => candidate.instanceId === instanceId);
  const completeMatch = pathname.match(COMPLETE);
  if (method === 'POST' && completeMatch && instance(completeMatch[1])) {
    const target = instance(completeMatch[1]);
    const body = await readJsonBody(request);
    record(`cloudProjectComplete:${target.projectId}`);
    if (
      body.operationId !== target.operationId ||
      body.fencingGeneration !== target.fencingGeneration
    ) {
      jsonResponse(response, 409, {
        error: 'The setup claim is no longer active',
        code: 'conflict',
      });
      return true;
    }
    target.state = 'READY';
    jsonResponse(response, 200, {
      instanceId: target.instanceId,
      state: target.state,
      readyAt: new Date().toISOString(),
    });
    return true;
  }

  const detachMatch = pathname.match(DETACH);
  if (method === 'POST' && detachMatch && instance(detachMatch[1])) {
    const target = instance(detachMatch[1]);
    record(`cloudProjectDetach:${target.projectId}`);
    target.state = 'DETACHED';
    jsonResponse(response, 200, {
      instanceId: target.instanceId,
      state: target.state,
    });
    return true;
  }

  const selectionMatch = pathname.match(SELECTION);
  if (selectionMatch && instance(selectionMatch[1])) {
    const target = instance(selectionMatch[1]);
    if (method === 'PUT') {
      const body = await readJsonBody(request);
      record(`cloudProjectSelection:${target.projectId}`);
      target.selectedRepositoryIds = body.selectedRepositoryIds;
      target.dismissedRepositoryIds = body.dismissedRepositoryIds;
      target.revision += 1;
    }
    jsonResponse(response, 200, {
      instanceId: target.instanceId,
      projectId: target.projectId,
      deviceId: target.deviceId,
      revision: target.revision,
      selectedRepositoryIds: target.selectedRepositoryIds,
      dismissedRepositoryIds: target.dismissedRepositoryIds,
    });
    return true;
  }
  return false;
}
