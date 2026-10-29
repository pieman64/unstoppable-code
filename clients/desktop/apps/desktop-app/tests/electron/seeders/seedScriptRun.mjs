import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive — seed a persisted worktree script-run snapshot so the
 * scripts drawer, the worktree script badge, and the dev-server open control
 * render from seeded state (no live script execution required).
 *
 * On-disk layout: a `{stem}.json` metadata file plus a sibling `{stem}.log`
 * output file under the worktree's script-runs directory:
 *
 *   workspaces/{workspaceId}/script-runs/{worktreeId}/{stem}.json
 *   workspaces/{workspaceId}/script-runs/{worktreeId}/{stem}.log
 *
 * Path source: `apps/desktop-app/src/main/lib/paths.ts`
 *   - `resolveScriptRunDir(projectId, worktreeId)` resolves to
 *     `getWorkspaceScriptRunDir` for workspace-typed entries, i.e.
 *     `getWorkspaceDir(workspaceId)/script-runs/{worktreeId}`. The harness
 *     always seeds workspace entries, and `getProjectDir === getWorkspaceDir`,
 *     so the workspace path is correct for both single- and multi-repo
 *     entries.
 *   - `buildScriptRunFileStem(scriptKey)` derives the file stem as
 *     `<sanitized-prefix>__<sha256(scriptKey).slice(0,12)>` (prefix lowercased,
 *     non-alphanumerics collapsed to `-`, trimmed, capped at 64 chars). This
 *     seeder replicates that exact algorithm so the reader's
 *     `getScriptRunPaths` resolves to the same files.
 *
 * Metadata shape: `PersistedScriptRunFile` from
 * `apps/desktop-app/src/main/lib/script-log-store.ts`. The reader
 * (`readMeta` -> `isPersistedScriptRunFile`) requires:
 *   { version: 1, runId: string, script: ScriptDescriptor,
 *     invocation: 'automatic-setup' | 'manual-run' | 'manual-lifecycle' |
 *       'workspace-lifecycle',
 *     status: 'running' | 'success' | 'failed' | 'cancelled',
 *     startedAt: string, updatedAt: string, completedAt?: string,
 *     exitCode: number | null, timedOut: boolean, durationMs: number }
 * and a valid `ScriptDescriptor`
 * (`packages/desktop-shared/src/types.ts`):
 *   { scriptKey, scriptName, label, command,
 *     lifecycle: ScriptLifecyclePhase | 'custom',
 *     target: 'project' | 'workspace-repo' | 'workspace-root',
 *     repoId?, repoName?, devServerPattern? }
 *
 * Log shape: plain newline-delimited text. `parseLogLines`
 * (`apps/desktop-app/src/main/lib/run-log-store.ts`) splits on `\n` and drops a
 * trailing empty line, so a trailing newline is safe. `readScriptRunLogTail` /
 * `listScriptRunLogTails` read the last N lines (capped at
 * `MAX_RUN_LOG_LINES = 2000`).
 *
 * Dev-server hit: the renderer derives dev-server URL hits by running each
 * `script.devServerPattern` entry over the run's output lines
 * (`apps/desktop-app/src/renderer/src/lib/scriptDevServerDetection.ts`
 * `extractDevServerHits`, fed from the persisted tail on reload — the
 * reload-backfill path, PR 824). To make a hit surface, this seeder defaults
 * the descriptor's `devServerPattern` to a localhost-matching regex and
 * appends a log line containing that URL. Callers can override both.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId workspace id (a.k.a. projectId)
 * @param {string} options.worktreeId worktree id
 * @param {Partial<import('@canopy/desktop-shared/types').ScriptDescriptor> & { scriptKey?: string }} [options.script]
 *   script descriptor overrides; defaults to a `launch`/`project` dev server.
 * @param {import('@canopy/desktop-shared/types').ScriptRunResponse extends never ? never : 'automatic-setup' | 'manual-run' | 'manual-lifecycle' | 'workspace-lifecycle'} [options.invocation]
 *   defaults to `'manual-lifecycle'`.
 * @param {'running' | 'success' | 'failed' | 'cancelled'} [options.status]
 *   defaults to `'running'` (an active dev server keeps the badge live).
 * @param {string} [options.runId] defaults to a deterministic seeded id.
 * @param {string} [options.startedAt] ISO timestamp; defaults to a fixed time.
 * @param {string} [options.updatedAt] ISO timestamp; defaults to `startedAt`.
 * @param {string} [options.completedAt] ISO timestamp; defaults based on status.
 * @param {number | null} [options.exitCode] defaults based on status.
 * @param {boolean} [options.timedOut] defaults to `false`.
 * @param {number} [options.durationMs] defaults to `0`.
 * @param {string[]} [options.outputLines] log tail lines; defaults to a short
 *   tail that includes a localhost dev-server URL.
 * @param {string} [options.devServerUrl] dev-server URL injected into the
 *   default output tail; defaults to `http://localhost:3000/`.
 * @returns {{ dirPath: string, metaPath: string, logPath: string,
 *   meta: object, lines: string[] }}
 */
export function seedScriptRun(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    script: scriptOverrides = {},
    invocation = 'manual-lifecycle',
    status = 'running',
    runId = 'seeded-script-run-1',
    startedAt = '2026-04-10T12:00:00.000Z',
    updatedAt,
    completedAt,
    exitCode,
    timedOut = false,
    durationMs = 0,
    outputLines,
    devServerUrl = 'http://localhost:3000/',
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedScriptRun requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedScriptRun requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedScriptRun requires worktreeId');
  }

  const scriptKey = scriptOverrides.scriptKey ?? 'launch:project';

  /** @type {import('@canopy/desktop-shared/types').ScriptDescriptor} */
  const script = {
    scriptKey,
    scriptName: 'launch',
    label: 'Dev Server',
    command: 'npm run dev',
    lifecycle: 'launch',
    target: 'project',
    // Default dev-server pattern so the reload-backfill path detects a hit from
    // the seeded output tail. A bare string entry is equivalent to
    // `{ pattern: value }` (see `ScriptDevServerPatternEntry`).
    devServerPattern: 'https?://[^\\s]+',
    ...scriptOverrides,
  };

  const isTerminal = status !== 'running';
  const resolvedExitCode =
    exitCode !== undefined
      ? exitCode
      : status === 'success'
        ? 0
        : status === 'failed'
          ? 1
          : null;
  const resolvedCompletedAt = isTerminal
    ? (completedAt ?? '2026-04-10T12:01:30.000Z')
    : completedAt;
  const resolvedUpdatedAt = updatedAt ?? resolvedCompletedAt ?? startedAt;

  /** @type {import('@canopy/desktop-shared/types').ScriptDescriptor extends never ? never : object} */
  const meta = {
    version: 1,
    runId,
    script,
    invocation,
    status,
    startedAt,
    updatedAt: resolvedUpdatedAt,
    ...(resolvedCompletedAt ? { completedAt: resolvedCompletedAt } : {}),
    exitCode: resolvedExitCode,
    timedOut,
    durationMs,
  };

  const lines = outputLines ?? [
    '> dev',
    '> npm run dev',
    '',
    'VITE ready in 312 ms',
    `  ➜  Local:   ${devServerUrl}`,
    '  ➜  press h + enter to show help',
  ];

  const dirPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'script-runs',
    worktreeId,
  );
  const stem = buildScriptRunFileStem(scriptKey);
  const metaPath = path.join(dirPath, `${stem}.json`);
  const logPath = path.join(dirPath, `${stem}.log`);

  writeJson(metaPath, meta);

  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

  return { dirPath, metaPath, logPath, meta, lines };
}

/**
 * Replicates `buildScriptRunFileStem` from
 * `apps/desktop-app/src/main/lib/paths.ts` so the seeded files land where the
 * reader expects them.
 *
 * @param {string} scriptKey
 * @returns {string}
 */
function buildScriptRunFileStem(scriptKey) {
  const prefix = scriptKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const digest = createHash('sha256')
    .update(scriptKey)
    .digest('hex')
    .slice(0, 12);
  return `${prefix || 'script'}__${digest}`;
}
