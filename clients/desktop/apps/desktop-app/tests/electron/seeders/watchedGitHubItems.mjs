// CAN-5258. Persisted display observations, with no live GitHub dependency.
// The watcher service projects these through the same snapshot/delta path as polling.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { seedWatchers } from './seedWatchers.mjs';

export function seedWatchedGitHubItems(
  userDataDir,
  destination,
  { failed = false } = {},
) {
  const observedAt = '2026-11-01T12:00:00.000Z';
  const repository = 'acme/api';
  const runId = failed ? '102' : '101';
  const prNumber = failed ? 8 : 7;
  const htmlUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  const file = path.join(userDataDir, 'app-advisor-watchers.json');
  const previous = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).watchers
    : [];
  seedWatchers({
    userDataDir,
    watchers: [
      ...previous,
      {
        id: failed ? 'portal-github-run-failed' : 'portal-github-run',
        ...(failed
          ? { status: 'delivery_failed', deliveryError: 'GitHub access lost' }
          : {}),
        trigger: 'github_workflow_runs_changed',
        label: 'Watched CI',
        destination,
        target: {
          kind: 'github_workflow_runs',
          items: [{ kind: 'workflow_run', repository, runId }],
          notifyOn: {
            statuses: [],
            conclusions: ['success'],
            jobConclusions: [],
          },
          display: { repositories: [repository], sample: [] },
        },
        runtimeState: {
          kind: 'github_workflow_runs',
          items: [
            {
              key: `${repository}/${runId}`,
              runAttempt: 2,
              last: {
                state: { kind: 'intermediate', status: 'in_progress' },
                runAttempt: 2,
                htmlUrl,
                workflowName: failed ? 'Unfollowed CI' : 'Portal CI',
                runNumber: 42,
                startedAt: observedAt,
                observedAt,
              },
              jobs: [
                {
                  jobId: '501',
                  name: 'Build',
                  status: 'completed',
                  conclusion: 'success',
                  htmlUrl: `${htmlUrl}/job/501`,
                  createdAt: observedAt,
                  completedAt: observedAt,
                  observedAt,
                },
                {
                  jobId: '502',
                  name: 'Tests',
                  status: 'in_progress',
                  conclusion: null,
                  htmlUrl: `${htmlUrl}/job/502`,
                  createdAt: '2026-11-01T12:01:00.000Z',
                  observedAt,
                },
              ],
            },
          ],
        },
      },
      {
        id: failed ? 'portal-github-pr-failed' : 'portal-github-pr',
        ...(failed
          ? { status: 'delivery_failed', deliveryError: 'GitHub access lost' }
          : {}),
        trigger: 'github_pull_requests_changed',
        label: 'Watched release',
        destination,
        target: {
          kind: 'github_pull_requests',
          items: [{ kind: 'pull_request', repository, number: prNumber }],
          display: { repositories: [repository], sample: [] },
        },
        runtimeState: {
          kind: 'github_pull_requests',
          items: [
            {
              key: `${repository}#${prNumber}`,
              last: {
                state: 'open',
                url: `https://github.com/${repository}/pull/${prNumber}`,
                title: failed ? 'Unfollowed PR' : 'Release the Portal',
                baseRefName: 'main',
                headSha: 'a'.repeat(40),
                mergedAt: null,
                mergeCommitSha: null,
                closedAt: null,
                queue: {
                  entryId: 'queue-entry',
                  enqueuedAt: observedAt,
                  phase: 'queued',
                  position: 3,
                },
                observedAt,
              },
            },
          ],
        },
      },
    ],
  });
}

export function watchedGitHubRunReceipt() {
  const htmlUrl = 'https://github.com/acme/api/actions/runs/101';
  return {
    version: 1,
    kind: 'github_workflow_run',
    operation: 'watch_github_items',
    dedupeKey: 'canopy:github_workflow_run:acme/api:101:2',
    createdAt: '2026-11-01T12:00:00.000Z',
    watcherId: 'portal-github-run',
    repository: 'acme/api',
    runId: '101',
    runAttempt: 2,
    workflowName: 'Portal CI',
    runNumber: 42,
    htmlUrl,
    state: { kind: 'intermediate', status: 'in_progress' },
    observedAt: '2026-11-01T12:00:00.000Z',
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId: '101',
      htmlUrl,
    },
  };
}
