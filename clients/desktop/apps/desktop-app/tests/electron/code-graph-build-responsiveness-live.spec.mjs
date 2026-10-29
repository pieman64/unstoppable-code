import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  initializeIsolatedCodexState,
  getScenarioActivity,
  buildApprovalRule,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Code-graph build responsiveness — the app stays responsive WHILE an
// off-main-thread code-graph build is in flight, and the build completes.
// The `-live` filename suffix is load-bearing: UI Automation uses it to keep
// mock-redirected LLM specs on the serialized live-LLM matrix tracks.
//
// TRIGGER-PATH CHOICE (highest-fidelity reachable surface):
//   The background build scheduler (`scheduleCodeGraphBuild`) is a hard no-op
//   under the E2E build (it mutates disk mid-test, gated exactly like the
//   worktree-summary scheduler), so the worktree-creation debounce path is NOT
//   reachable here. The highest-fidelity path that IS reachable is the real
//   `BuildOrUpdateCodeGraph` MCP tool driven by a live Claude turn against the
//   mock LLM — the identical mechanism proven by `chat-tool-call-live.spec.mjs`.
//   `build_or_update_code_graph` is allowlisted on the `native-sdk` surface
//   (worktree Claude chat), so a scripted `tool_use` reaches the SAME
//   production path a real agent would:
//     MCP server → canopy-tools/core → buildOrUpdateCodeGraph →
//     runWorktreeCodeGraphBuild → compatible base selection/fusion →
//     runCodeGraphWorkerBuild → utilityProcess.fork(code-graph-build-worker.js)
//     → CodeGraphEngine build (web-tree-sitter parse + node:sqlite + resolvers
//     + Louvain/flows) → WAL commit → response → tool result.
//   This exercises the real forked worker (not a stub), which is the whole
//   point of the off-main change.
//
// The scripted conversation is THREE steps:
//   step 0 — `tool_use` for `mcp__canopy__BuildOrUpdateCodeGraph`. The bundled
//            `claude` binary executes it; the build runs OFF the main thread in
//            the forked worker. WHILE it runs (between the "Build Code Graph"
//            card and the next card) we hammer a renderer→main→renderer IPC
//            round trip and record its latency: if the build ran on the main
//            thread, the main event loop would stall and these round trips
//            would spike past the generous bound (the negative control).
//   step 1 — `tool_use` for `mcp__canopy__GetCodeGraphContext`. Resolved once
//            the build tool_result is sent back. This READS the just-built
//            graph through the in-process `CodeGraphWorktreeService` (a fresh
//            sqlite connection, a different process than the worker that wrote
//            it) — proving WAL cross-connection read visibility and that the
//            "status surface" shows a real built graph.
//   step 2 — final text, resolved after the context tool_result returns.
//
// A green run proves: (a) the forked worker really builds a multi-file graph,
// (b) the renderer↔main IPC stays fast throughout that build, and (c) the graph
// is committed and readable afterwards.
//
// See `chat-tool-call-live.spec.mjs` for the env-hygiene rationale behind
// `withBundledBinaryOverridesScrubbed` and the live-turn marker mechanics.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

const CONVERSATION_MARKER = 'Canopy-CGRAPHBUILD';
// No trailing punctuation: assistant text streams into a markdown <span> and a
// trailing '.' is not reliably part of the same matched text node.
const FOLLOW_UP_REPLY = 'Finished building and reading the code graph';
const BENIGN_BASH_REPLY = 'Finished the benign Bash command';
const STEERING_REPLY = 'Finished the graph-steered exploration';
const DISABLED_STEERING_REPLY = 'Finished exploration with code graph disabled';
const GRAPH_STEERING_NEEDLE =
  'For structural codebase exploration, call mcp__canopy__GetCodeGraphContext';

// Enough real source files that the forked build takes several seconds —
// comfortably longer than RESPONSIVE_BOUND_MS, so a hypothetical main-thread
// build would visibly stall the app past the bound (the negative control),
// while staying well under the test budget. Generated (not vendored) and picked
// up by the scanner via `git ls-files --others --exclude-standard`
// (uncommitted-but-not-ignored files are scanned), so no commit is needed.
// Local run: ~600 files ≈ 2.4s build; 1200 files ≈ 4–6s.
const FIXTURE_FILE_COUNT = 1200;

// Generous per-sample ceiling. A healthy renderer→main→renderer round trip is
// single-digit-to-tens of ms; this bound absorbs CI contention while still
// being far below the multi-second stall a main-thread build would produce.
const RESPONSIVE_BOUND_MS = 2500;
// The build window must yield at least this many round-trip samples — a guard
// that the fixture is genuinely non-trivial (a would-be instant build fails
// here, prompting a bigger fixture) and that we actually probed during it.
const MIN_SAMPLES = 3;
// Hard cap on the sampling loop so a hung build can never wedge the spec; the
// test's own timeout is the real backstop.
const MAX_BUILD_WINDOW_MS = 150_000;
const WORKSPACE_ROOT_REPO_ID = '__workspace_root__';

function noCustomLanguagesFingerprint() {
  return createHash('sha256')
    .update('code-graph-custom-inputs-v1')
    .update('\0')
    .update('config:absent')
    .digest('hex');
}

function publishedBasePointerPath(userDataDir, repoPath) {
  const shadowKey = createHash('sha256')
    .update(repoPath)
    .digest('hex')
    .slice(0, 16);
  const variantHash = createHash('sha256')
    .update('code-graph-base-variant-v1\0')
    .update(WORKSPACE_ROOT_REPO_ID)
    .update('\0')
    .update(noCustomLanguagesFingerprint())
    .digest('hex')
    .slice(0, 32);
  return path.join(
    userDataDir,
    'repo-shadows',
    shadowKey,
    'code-graph',
    variantHash,
    'current.json',
  );
}

function readSeedProvenance(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM graph_metadata WHERE key = 'seed_provenance'")
      .get();
    return typeof row?.value === 'string' ? JSON.parse(row.value) : [];
  } finally {
    db.close();
  }
}

function configureLocalOrigin(repoPath, userDataDir) {
  const originPath = path.join(userDataDir, 'code-graph-origin.git');
  execFileSync('git', ['clone', '--bare', repoPath, originPath]);
  execFileSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
  });
}

// Writes `FIXTURE_FILE_COUNT` interconnected TS modules into the worktree
// checkout. Each module imports and calls three siblings, so the build has real
// parse + TS module-resolution + call-binding + derived-analysis (community /
// flow) work — not a trivial pile of leaf files. Files are never executed, so
// the deterministic import ring is harmless.
function generateGraphFixture(worktreePath, count) {
  const dir = path.join(worktreePath, 'graph-fixture');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const a = (i + 1) % count;
    const b = (i + 2) % count;
    const c = (i + 3) % count;
    const source = `// Generated fixture module ${i} (code-graph responsiveness spec).
import { fn${a}_0 } from './mod${a}';
import { fn${b}_1 } from './mod${b}';
import { fn${c}_2 } from './mod${c}';

export interface Shape${i} {
  id: number;
  label: string;
}

export function fn${i}_0(seed: number): number {
  let total = seed + ${i};
  total += fn${a}_0(seed % 7);
  return total;
}

export function fn${i}_1(seed: number): number {
  return fn${b}_1(seed % 5) + ${i};
}

export function fn${i}_2(seed: number): number {
  return fn${c}_2(seed % 3) * 2 + ${i};
}

export function fn${i}_3(input: Shape${i}): string {
  return \`\${input.label}:\${fn${i}_0(input.id)}:\${fn${i}_1(input.id)}\`;
}
`;
    writeFileSync(path.join(dir, `mod${i}.ts`), source, 'utf8');
  }
  return dir;
}

// Flattens every persisted block across all tabs/messages in the worktree chat.
function readPersistedBlocks(userDataDir) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${WORKTREE_ID}.json`),
    )
  )
    return [];
  const parsed = readChatStorageTabs(workspaceRoot, WORKTREE_ID);
  const blocks = [];
  for (const tab of parsed.tabs ?? []) {
    for (const message of tab.messages ?? []) {
      for (const block of message.blocks ?? []) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

// Finds the tool_result whose output includes `needle` and parses its JSON
// payload (the tool returns `JSON.stringify(result, null, 2)`).
function findToolResultPayload(blocks, needle) {
  for (const block of blocks) {
    if (
      block?.type === 'tool_result' &&
      typeof block.output === 'string' &&
      block.output.includes(needle)
    ) {
      try {
        return JSON.parse(block.output);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Keep the real build runner admitted while a real read worker observes a
// fixture fault. Only the generated graph's initial build message is held;
// reads, provider delivery and the worker implementations are untouched.
async function holdGraphBuildMessage(electronApp, dbPath) {
  await electronApp.evaluate(({ utilityProcess }, targetDbPath) => {
    if (globalThis.__graphReadFailureBuildHold) {
      throw new Error('A graph build hold is already installed');
    }
    const originalFork = utilityProcess.fork;
    const held = [];
    utilityProcess.fork = function (...args) {
      const child = originalFork.apply(utilityProcess, args);
      if (!String(args[0]).endsWith('code-graph-build-worker.js')) return child;
      const originalPost = child.postMessage;
      child.postMessage = function (message, ...ports) {
        if (message?.dbPath !== targetDbPath) {
          return originalPost.call(child, message, ...ports);
        }
        held.push({ child, originalPost, message, ports });
      };
      return child;
    };
    globalThis.__graphReadFailureBuildHold = {
      count: () => held.length,
      release() {
        utilityProcess.fork = originalFork;
        for (const { child, originalPost, message, ports } of held) {
          child.postMessage = originalPost;
          originalPost.call(child, message, ...ports);
        }
        delete globalThis.__graphReadFailureBuildHold;
      },
    };
  }, dbPath);
  return {
    count: () =>
      electronApp.evaluate(
        () => globalThis.__graphReadFailureBuildHold?.count() ?? 0,
      ),
    release: () =>
      electronApp.evaluate(() =>
        globalThis.__graphReadFailureBuildHold?.release(),
      ),
  };
}

test('an injected context tool delivers a real read error while a retained graph refresh is pending', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-graph-pending-read-error-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
    rules: [],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'pending-read-error', title: 'Graph read error' }],
  });
  const marker = 'Canopy-CGRAPH-PENDING-READ-ERROR';
  const reply = 'Finished checking the retained graph read failure';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'mcp__canopy__GetCodeGraphContext', input: {} }],
          stopReason: 'tool_use',
        },
        { text: reply, stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const dbPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'code-graph',
    'graph.db',
  );
  let hold;
  let fixtureDatabase;
  let metadataRenamed = false;
  let buildDispatched = false;
  let window;
  try {
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const built = await window.evaluate(
      (request) => window.api.codeGraphBuildWorktree(request),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(built.state).toBe('ready');
    expect(built.enabled).toBe(true);
    expect(built.totals.fileCount).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(() =>
              window.api.codeGraphGetGenerationQueue(),
            )
          ).entries.length,
      )
      .toBe(0);
    fixtureDatabase = new DatabaseSync(dbPath);
    expect(
      fixtureDatabase
        .prepare(
          "SELECT value FROM graph_metadata WHERE key = 'completed_build_at'",
        )
        .get()?.value,
    ).toBeDefined();

    hold = await holdGraphBuildMessage(electronApp, dbPath);
    await window.evaluate(
      (request) => {
        window.__graphReadFailureRefresh =
          window.api.codeGraphBuildWorktree(request);
      },
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    buildDispatched = true;
    await expect.poll(() => hold.count()).toBe(1);
    await expect
      .poll(async () => {
        const queue = await window.evaluate(() =>
          window.api.codeGraphGetGenerationQueue(),
        );
        return queue.entries.some((entry) => entry.worktreeId === WORKTREE_ID);
      })
      .toBe(true);

    // The committed metadata remains in this generated fixture, under a
    // temporary name. Both the current full reader and future metadata reader
    // must encounter a real SQLite failure, independent of wall-clock speed.
    fixtureDatabase.exec(
      'ALTER TABLE graph_metadata RENAME TO graph_metadata_read_failure_fixture',
    );
    metadataRenamed = true;
    expect(() =>
      fixtureDatabase.prepare('SELECT value FROM graph_metadata').get(),
    ).toThrow(/no such table/);
    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Read the retained graph context.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByTestId('panel-content-chat').getByText(reply).first(),
    ).toBeVisible({ timeout: 90_000 });
    let payload;
    await expect
      .poll(() => {
        payload = findToolResultPayload(
          readPersistedBlocks(userDataDir),
          '"hasGraph"',
        );
        return payload !== null;
      })
      .toBe(true);
    expect(await hold.count()).toBe(1);
    expect(payload.status).toBe('error');
    expect(payload.hasGraph).toBe(true);
    expect(payload.readFailure).toBe('database-error');
    expect(payload.summary).not.toMatch(
      /no such table|graph_metadata|\/Users\/|SELECT/i,
    );
    const contextResult = readPersistedBlocks(userDataDir).find(
      (block) =>
        block.type === 'tool_result' && block.output?.includes('"hasGraph"'),
    );
    expect(contextResult?.isError).toBe(true);
  } finally {
    try {
      if (metadataRenamed) {
        fixtureDatabase.exec(
          'ALTER TABLE graph_metadata_read_failure_fixture RENAME TO graph_metadata',
        );
      }
    } finally {
      try {
        fixtureDatabase?.close();
      } finally {
        try {
          await hold?.release();
          if (buildDispatched) {
            await window.evaluate(async () => {
              await window.__graphReadFailureRefresh;
              delete window.__graphReadFailureRefresh;
            });
          }
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      }
    }
  }
});

test('a real Codex injected context tool delivers a read error while a retained graph refresh is pending', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-graph-pending-read-error-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeModelByProvider: {
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
        },
      },
    }),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
    rules: [],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: 'pending-read-error',
    tabs: [
      {
        id: 'pending-read-error',
        title: 'Graph read error',
        providerType: 'codex',
      },
    ],
  });
  const marker = 'Canopy-CODEX-CGRAPH-PENDING-READ-ERROR';
  const reply = 'Finished checking the retained graph read failure';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'canopy_get_code_graph_context', input: {} }],
          stopReason: 'tool_use',
        },
        { text: reply, stopReason: 'end_turn' },
      ],
    },
  });
  initializeIsolatedCodexState(userDataDir);
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const dbPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'code-graph',
    'graph.db',
  );
  let hold;
  let fixtureDatabase;
  let metadataRenamed = false;
  let buildDispatched = false;
  let window;
  try {
    window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const built = await window.evaluate(
      (request) => window.api.codeGraphBuildWorktree(request),
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(built.state).toBe('ready');
    expect(built.enabled).toBe(true);
    expect(built.totals.fileCount).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(() =>
              window.api.codeGraphGetGenerationQueue(),
            )
          ).entries.length,
      )
      .toBe(0);
    fixtureDatabase = new DatabaseSync(dbPath);
    expect(
      fixtureDatabase
        .prepare(
          "SELECT value FROM graph_metadata WHERE key = 'completed_build_at'",
        )
        .get()?.value,
    ).toBeDefined();

    hold = await holdGraphBuildMessage(electronApp, dbPath);
    await window.evaluate(
      (request) => {
        window.__graphReadFailureRefresh =
          window.api.codeGraphBuildWorktree(request);
      },
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    buildDispatched = true;
    await expect.poll(() => hold.count()).toBe(1);
    await expect
      .poll(async () => {
        const queue = await window.evaluate(() =>
          window.api.codeGraphGetGenerationQueue(),
        );
        return queue.entries.some((entry) => entry.worktreeId === WORKTREE_ID);
      })
      .toBe(true);

    // The committed metadata remains in this generated fixture, under a
    // temporary name. Both the current full reader and future metadata reader
    // must encounter a real SQLite failure, independent of wall-clock speed.
    fixtureDatabase.exec(
      'ALTER TABLE graph_metadata RENAME TO graph_metadata_read_failure_fixture',
    );
    metadataRenamed = true;
    expect(() =>
      fixtureDatabase.prepare('SELECT value FROM graph_metadata').get(),
    ).toThrow(/no such table/);
    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Read the retained graph context.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByTestId('panel-content-chat').getByText(reply).first(),
    ).toBeVisible({ timeout: 90_000 });
    let payload;
    await expect
      .poll(() => {
        payload = findToolResultPayload(
          readPersistedBlocks(userDataDir),
          '"hasGraph"',
        );
        return payload !== null;
      })
      .toBe(true);
    expect(await hold.count()).toBe(1);
    expect(payload.status).toBe('error');
    expect(payload.hasGraph).toBe(true);
    expect(payload.readFailure).toBe('database-error');
    expect(payload.summary).not.toMatch(
      /no such table|graph_metadata|\/Users\/|SELECT/i,
    );
    const contextResult = readPersistedBlocks(userDataDir).find(
      (block) =>
        block.type === 'tool_result' && block.output?.includes('"hasGraph"'),
    );
    expect(contextResult?.isError).toBe(true);
    const contextCall = readPersistedBlocks(userDataDir).find(
      (block) =>
        block.type === 'tool_use' &&
        block.toolName === 'canopy_get_code_graph_context',
    );
    expect(contextCall).toBeDefined();
    expect(contextResult?.toolUseId).toBe(contextCall.toolUseId);
    expect(contextCall.toolUseId).toBeTruthy();
    const activity = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker);
    expect(
      activity.activity['completedTool:canopy_get_code_graph_context'],
    ).toBeGreaterThan(0);
    await test.info().attach('codex-code-graph-tool-evidence', {
      body: Buffer.from(
        JSON.stringify({ contextCall, contextResult, activity }),
      ),
      contentType: 'application/json',
    });
  } finally {
    try {
      if (metadataRenamed) {
        fixtureDatabase.exec(
          'ALTER TABLE graph_metadata_read_failure_fixture RENAME TO graph_metadata',
        );
      }
    } finally {
      try {
        fixtureDatabase?.close();
      } finally {
        try {
          await hold?.release();
          if (buildDispatched) {
            await window.evaluate(async () => {
              await window.__graphReadFailureRefresh;
              delete window.__graphReadFailureRefresh;
            });
          }
        } finally {
          await closeCanopy(electronApp, userDataDir);
        }
      }
    }
  }
});

// One renderer→main→renderer IPC round trip, timed inside the page. Reaching
// the main-process preferences handler and back exercises the main event loop;
// if a build were blocking it, this would not resolve until the build freed it.
async function measureIpcRoundTripMs(window) {
  return window.evaluate(async () => {
    const start = performance.now();
    await window.api.loadPreferences();
    return performance.now() - start;
  });
}

test.describe('code-graph build responsiveness', () => {
  test('the app stays responsive while an off-main code-graph build runs, and the build completes', async () => {
    // Bundled Claude spawn + a multi-second forked build + a 3-step tool loop
    // runs well past the 60s default.
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-code-graph-responsiveness-'),
    );

    // Phase 1: a real git worktree (plain `ts-pnpm-vite` fixture).
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
      rules: [
        buildApprovalRule({
          id: 'allow-code-graph-build',
          behavior: 'allow',
          target: {
            kind: 'mcp',
            server: 'canopy',
            tool: 'BuildOrUpdateCodeGraph',
          },
        }),
        buildApprovalRule({
          id: 'allow-code-graph-context',
          behavior: 'allow',
          target: {
            kind: 'mcp',
            server: 'canopy',
            tool: 'GetCodeGraphContext',
          },
        }),
      ],
    });
    const workspace = seed?.workspaces?.[0];
    if (!workspace?.repoPath) {
      throw new Error('code-graph fixture project was not seeded');
    }
    configureLocalOrigin(workspace.repoPath, userDataDir);
    const worktreePath =
      workspace?.worktreePath ??
      path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'worktrees',
        WORKTREE_ID,
      );

    // Phase 1: generate a substantial real-source corpus so the build is a
    // genuine multi-second unit of work.
    generateGraphFixture(worktreePath, FIXTURE_FILE_COUNT);

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    // Register a build/context turn followed by a raw Grep turn. The latter
    // proves that a new user turn resets graph orientation and the Claude
    // PreToolUse hook injects the graph-first reminder into provider context.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        requestTextObservers: [
          { key: 'graph-steering', text: GRAPH_STEERING_NEEDLE },
        ],
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__BuildOrUpdateCodeGraph',
                input: {},
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                name: 'mcp__canopy__GetCodeGraphContext',
                input: {},
              },
            ],
            stopReason: 'tool_use',
          },
          { text: FOLLOW_UP_REPLY, stopReason: 'end_turn' },
          {
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  command: `printf 'grep handling' > ${worktreePath}/benign-bash-command-ran`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: BENIGN_BASH_REPLY, stopReason: 'end_turn' },
          {
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  command: `rg -n 'export function' ${worktreePath}/graph-fixture --glob '*.ts'; touch ${worktreePath}/graph-steering-should-not-run`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: STEERING_REPLY, stopReason: 'end_turn' },
          {
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  command: `rg -n 'export function' ${worktreePath}/graph-fixture --glob '*.ts' > ${worktreePath}/graph-steering-disabled-command-ran`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: DISABLED_STEERING_REPLY, stopReason: 'end_turn' },
        ],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await expect(
        window
          .locator(`[data-sidebar-workspace-id="${WORKSPACE_ID}"]`)
          .getByText(WORKSPACE_NAME),
      ).toBeVisible();

      // Project loading starts base maintenance without blocking the UI. Wait
      // for the immutable default-branch generation so this first tool build
      // must exercise base copy/fusion before reconciling the untracked fixture.
      const basePointerPath = publishedBasePointerPath(
        userDataDir,
        workspace.repoPath,
      );
      await expect
        .poll(() => existsSync(basePointerPath), {
          timeout: 120_000,
          message: 'default-branch code-graph base is published',
        })
        .toBe(true);

      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      const userMessage = `[${CONVERSATION_MARKER}] Build the code graph for this worktree, then read its context.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The build's tool card marks the START of the off-main build window.
      const buildCard = panel.getByText('Build Code Graph').first();
      await expect(buildCard).toBeVisible({ timeout: 120_000 });

      // Sample renderer↔main IPC round trips throughout the build window.
      // The persisted build tool_result is the durable END marker. Completed
      // turns collapse their tool cards into a summary, so using the context
      // card text here would race that collapse in faster environments.
      const samples = [];
      const windowStart = Date.now();
      let buildResultObserved = false;
      while (Date.now() - windowStart < MAX_BUILD_WINDOW_MS) {
        buildResultObserved =
          findToolResultPayload(
            readPersistedBlocks(userDataDir),
            'Built code graph',
          ) !== null;
        if (buildResultObserved) {
          break;
        }
        samples.push(await measureIpcRoundTripMs(window));
      }
      const windowDurationMs = Date.now() - windowStart;

      expect(buildResultObserved, 'build tool result persisted').toBe(true);

      // The whole turn completed (final text after the context tool_result).
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // ---- Responsiveness evidence + assertions --------------------------
      const maxLatencyMs = samples.length > 0 ? Math.max(...samples) : Infinity;
      const sorted = [...samples].sort((x, y) => x - y);
      const medianLatencyMs =
        sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : Infinity;

      // ---- Build-completed evidence (status surface / WAL read) ----------
      let buildPayload = null;
      let contextPayload = null;
      await expect
        .poll(
          () => {
            const blocks = readPersistedBlocks(userDataDir);
            buildPayload = findToolResultPayload(blocks, 'Built code graph');
            contextPayload = findToolResultPayload(blocks, '"hasGraph"');
            return buildPayload !== null && contextPayload !== null;
          },
          {
            timeout: 20_000,
            message: 'build + context tool results persisted',
          },
        )
        .toBe(true);

      const dbPath = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'worktree-data',
        WORKTREE_ID,
        'code-graph',
        'graph.db',
      );
      const seedProvenance = readSeedProvenance(dbPath);

      test.info().annotations.push({
        type: 'code-graph-responsiveness',
        description: JSON.stringify({
          fixtureFiles: FIXTURE_FILE_COUNT,
          buildStatus: buildPayload?.status,
          filesScanned: buildPayload?.filesScanned,
          filesParsed: buildPayload?.filesParsed,
          buildDurationMs: buildPayload?.durationMs,
          contextHasGraph: contextPayload?.hasGraph,
          contextSymbolCount: contextPayload?.symbolCount,
          contextEdgeCount: contextPayload?.edgeCount,
          ipcSamples: samples.length,
          ipcMaxMs: Number.isFinite(maxLatencyMs)
            ? Math.round(maxLatencyMs)
            : null,
          ipcMedianMs: Number.isFinite(medianLatencyMs)
            ? Math.round(medianLatencyMs)
            : null,
          buildWindowMs: windowDurationMs,
          graphDbBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
          seededRepositories: seedProvenance.length,
        }),
      });
      console.log(
        `[code-graph-responsiveness] files=${FIXTURE_FILE_COUNT} ` +
          `build.status=${buildPayload?.status} parsed=${buildPayload?.filesParsed} ` +
          `build.durationMs=${buildPayload?.durationMs} ` +
          `context.hasGraph=${contextPayload?.hasGraph} symbols=${contextPayload?.symbolCount} ` +
          `ipc.samples=${samples.length} ipc.maxMs=${Math.round(maxLatencyMs)} ` +
          `ipc.medianMs=${Math.round(medianLatencyMs)} windowMs=${windowDurationMs} ` +
          `graphDbBytes=${existsSync(dbPath) ? statSync(dbPath).size : 0} ` +
          `seededRepositories=${seedProvenance.length}`,
      );

      // The forked build produced a real, successful graph over the fixture.
      expect(buildPayload?.status).toBe('ok');
      expect(buildPayload?.filesParsed ?? 0).toBeGreaterThanOrEqual(
        FIXTURE_FILE_COUNT,
      );
      expect(seedProvenance).toEqual([
        expect.objectContaining({ repoId: WORKSPACE_ROOT_REPO_ID }),
      ]);
      // The in-process read (a different connection than the worker) sees the
      // WAL-committed graph — the "status surface shows a built graph".
      expect(contextPayload?.hasGraph).toBe(true);
      expect(contextPayload?.symbolCount ?? 0).toBeGreaterThan(0);
      // The on-disk artifact exists.
      expect(existsSync(dbPath)).toBe(true);

      // The window was a genuine unit of work AND main stayed responsive
      // throughout it. A main-thread build would blow past RESPONSIVE_BOUND_MS.
      expect(samples.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      expect(maxLatencyMs).toBeLessThan(RESPONSIVE_BOUND_MS);

      await window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          await window.api.approvals.setMode({
            projectId,
            worktreeId,
            chatId,
            mode: 'auto',
            previousMode: 'full-access',
          });
        },
        {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: 't1',
        },
      );

      const benignBashMessage = `[${CONVERSATION_MARKER}] Run a non-search Bash command whose quoted argument mentions grep.`;
      await composer.click();
      await composer.fill(benignBashMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      const benignApprovalCard = window.getByTestId('tool-approval-card');
      await expect(benignApprovalCard).toBeVisible({ timeout: 60_000 });
      await expect(benignApprovalCard).toContainText('grep handling');
      await window.getByTestId('tool-approval-allow').click();
      await expect(benignApprovalCard).toHaveCount(0);
      await expect(panel.getByText(BENIGN_BASH_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });
      expect(
        existsSync(path.join(worktreePath, 'benign-bash-command-ran')),
      ).toBe(true);

      const explorationMessage = `[${CONVERSATION_MARKER}] Trace exports across the source tree.`;
      await composer.click();
      await composer.fill(explorationMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(STEERING_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });
      expect(
        existsSync(path.join(worktreePath, 'graph-steering-should-not-run')),
      ).toBe(false);
      await expect
        .poll(
          async () => {
            const observed = await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              CONVERSATION_MARKER,
            );
            return observed.activity?.['llmObserved:graph-steering'] ?? 0;
          },
          {
            timeout: 20_000,
            message:
              'Claude provider request includes graph-first hook context',
          },
        )
        .toBeGreaterThan(0);

      await window.evaluate(async () => {
        const preferences = await window.api.loadPreferences();
        await window.api.savePreferences({
          codeGraph: {
            ...preferences.codeGraph,
            mode: 'disabled',
          },
        });
      });

      const disabledExplorationMessage = `[${CONVERSATION_MARKER}] Trace exports again with the code graph disabled.`;
      await composer.click();
      await composer.fill(disabledExplorationMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      // A disabled graph must bypass the graph-first soft block and reach the
      // ordinary approval path even though the built graph remains on disk.
      // While enabled, the same broad command is denied before this card can
      // render.
      const disabledApprovalCard = window.getByTestId('tool-approval-card');
      await expect(disabledApprovalCard).toBeVisible({ timeout: 60_000 });
      await expect(disabledApprovalCard).toContainText(
        'graph-steering-disabled-command-ran',
      );
      await window.getByTestId('tool-approval-allow').click();
      await expect(disabledApprovalCard).toHaveCount(0);
      await expect(
        panel.getByText(DISABLED_STEERING_REPLY).first(),
      ).toBeVisible({ timeout: 90_000 });
      expect(
        existsSync(
          path.join(worktreePath, 'graph-steering-disabled-command-ran'),
        ),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// Audit regression: drive real graph tools from the chat composer, then inspect
// their persisted results. The source fixtures are never executed.
test('graph queries preserve lexical callers, exported bindings and identifier search', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-graph-audit-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seed.workspaces[0];
  const worktreePath = workspace.worktreePath;
  const fixtureDir = path.join(worktreePath, 'audit');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    path.join(fixtureDir, 'scope.ts'),
    `export function first(){
    function helper(){ return 1; }
    return helper();
  }
  export function second(){
    function helper(){ return 2; }
    return helper();
  }
  export function outer(){ function inner(){ return 1; } return inner(); }
  export function calculateInvoiceTotal(){ return 1; }
  export function 处理订单(){ return 1; }
  `,
  );
  writeFileSync(
    path.join(fixtureDir, 'lib.ts'),
    'export function work(){ return 1; }\n',
  );
  writeFileSync(
    path.join(fixtureDir, 'barrel.ts'),
    "export { work } from './lib';\n",
  );
  writeFileSync(
    path.join(fixtureDir, 'consumer.ts'),
    "import { work } from './barrel'; export function consume(){ return work(); }\n",
  );
  const aliasConfig = (target) =>
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@audit': [target] } },
    });
  writeFileSync(path.join(fixtureDir, 'tsconfig.json'), aliasConfig('lib.ts'));
  writeFileSync(
    path.join(fixtureDir, 'other.ts'),
    'export function work(){ return 2; }\n',
  );
  writeFileSync(
    path.join(fixtureDir, 'alias.ts'),
    "import { work } from '@audit'; export function aliasConsumer(){ work(); }\n",
  );
  const sameStatPath = path.join(fixtureDir, 'stat.ts');
  writeFileSync(sameStatPath, 'export function oldName(){ return 1; }\n');
  utimesSync(sameStatPath, 1700000000, 1700000000);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
    rules: [],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  const marker = 'Canopy-CGRAPH-AUDIT';
  writeFileSync(
    path.join(fixtureDir, 'schema.prisma'),
    'model User {\n id String @id\n ref Missing\n Missing String\n}',
  );
  writeFileSync(path.join(fixtureDir, 'native.swift'), 'func nativeWork() {}');
  const calls = [
    { name: 'BuildOrUpdateCodeGraph', input: {} },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'relationship-path',
        target: 'audit/schema.prisma::User.ref',
        to: 'audit/schema.prisma::User.Missing',
        maxDepth: 1,
      },
    },

    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'call-path',
        target: 'audit/consumer.ts::consume',
        to: 'audit/lib.ts::work',
      },
    },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'relationship-path',
        target: 'audit/lib.ts::work',
        to: 'audit/consumer.ts::consume',
      },
    },
    { name: 'SearchCodeGraph', input: { query: 'nativeWork' } },
    { name: 'SearchCodeGraph', input: { query: 'schema.prisma::User' } },

    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'callers',
        target: 'audit/scope.ts::first.helper',
        detailLevel: 'standard',
      },
    },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'callers',
        target: 'audit/scope.ts::outer.inner',
        detailLevel: 'standard',
      },
    },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'callers',
        target: 'audit/lib.ts::work',
        detailLevel: 'standard',
      },
    },
    {
      name: 'SearchCodeGraph',
      input: { query: 'calculateInvoice', detailLevel: 'standard' },
    },
    {
      name: 'SearchCodeGraph',
      input: { query: '处理订单', detailLevel: 'standard' },
    },
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        ...calls.map((call) => ({
          toolCalls: [{ name: `mcp__canopy__${call.name}`, input: call.input }],
          stopReason: 'tool_use',
        })),
        { text: 'Audit graph queries finished', stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const composer = window.getByRole('textbox').first();
    await composer.fill(
      `[${marker}] Build the graph and query callers and symbol names.`,
    );
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('Audit graph queries finished')
        .first(),
    ).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        () =>
          readPersistedBlocks(userDataDir).some(
            (block) =>
              block.type === 'text' &&
              block.text === 'Audit graph queries finished',
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const blocks = readPersistedBlocks(userDataDir);
    for (const [target, expected] of [
      ['audit/scope.ts::first.helper', 'audit/scope.ts::first'],
      ['audit/scope.ts::outer.inner', 'audit/scope.ts::outer'],
      ['audit/lib.ts::work', 'audit/consumer.ts::consume'],
    ]) {
      const result = blocks
        .filter((block) => block.type === 'tool_result')
        .map((block) => {
          try {
            return JSON.parse(block.output);
          } catch {
            return null;
          }
        })
        .find((value) => value?.mode === 'callers' && value.target === target);
      expect
        .soft(
          result?.hits?.map((hit) => hit.qualifiedName),
          target,
        )
        .toContain(expected);
    }
    for (const name of ['calculateInvoiceTotal', '处理订单']) {
      const found = blocks
        .filter((block) => block.type === 'tool_result')
        .some((block) => {
          try {
            return JSON.parse(block.output).hits?.some(
              (hit) => hit.qualifiedName === `audit/scope.ts::${name}`,
            );
          } catch {
            return false;
          }
        });
      expect.soft(found, `search finds ${name}`).toBe(true);
    }

    const payloads = blocks
      .filter((block) => block.type === 'tool_result')
      .flatMap((block) => {
        try {
          return [JSON.parse(block.output)];
        } catch {
          return [];
        }
      });
    expect(
      payloads.find((value) => value.mode === 'call-path')?.path,
    ).toMatchObject({
      status: 'found',
      hops: [
        { kind: 'CALLS', direction: 'forward', filePath: 'audit/consumer.ts' },
      ],
    });
    expect(
      payloads.find(
        (value) =>
          value.mode === 'relationship-path' &&
          value.target === 'audit/lib.ts::work',
      )?.path,
    ).toMatchObject({
      status: 'found',
      hops: [{ kind: 'CALLS', direction: 'reverse' }],
    });
    for (const target of [
      'audit/native.swift::nativeWork',
      'audit/schema.prisma::User',
    ])
      expect(
        payloads.some((value) =>
          value.hits?.some((hit) => hit.qualifiedName === target),
        ),
      ).toBe(true);

    expect(
      payloads.find((value) => value.target === 'audit/schema.prisma::User.ref')
        ?.path?.status,
    ).toBe('budget-exhausted');
    // An ordinary user edit followed by an explicit rebuild through the chat.
    // The consumer stays byte-for-byte unchanged; the rename preserves stat size/time.
    writeFileSync(
      path.join(fixtureDir, 'tsconfig.json'),
      aliasConfig('other.ts'),
    );
    writeFileSync(sameStatPath, 'export function newName(){ return 1; }\n');
    utimesSync(sameStatPath, 1700000000, 1700000000);
    const refreshMarker = marker;
    await registerScenario(DEFAULT_MOCK_BASE_URL, refreshMarker, {
      llm: {
        steps: [
          ...calls.map((call) => ({
            toolCalls: [
              { name: `mcp__canopy__${call.name}`, input: call.input },
            ],
            stopReason: 'tool_use',
          })),
          { text: 'Audit graph queries finished', stopReason: 'end_turn' },

          ...[
            { name: 'BuildOrUpdateCodeGraph', input: {} },
            { name: 'GetCodeGraphContext', input: {} },
            {
              name: 'QueryCodeGraph',
              input: {
                mode: 'callers',
                target: 'audit/other.ts::work',
                detailLevel: 'standard',
              },
            },
            {
              name: 'SearchCodeGraph',
              input: { query: 'newName', detailLevel: 'standard' },
            },
          ].map((call) => ({
            toolCalls: [
              { name: `mcp__canopy__${call.name}`, input: call.input },
            ],
            stopReason: 'tool_use',
          })),
          { text: 'Audit graph refresh finished', stopReason: 'end_turn' },
        ],
      },
    });
    await composer.fill(
      `[${refreshMarker}] Rebuild after my edits and check the graph.`,
    );
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('Audit graph refresh finished')
        .first(),
    ).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        () =>
          readPersistedBlocks(userDataDir).some(
            (block) =>
              block.type === 'text' &&
              block.text === 'Audit graph refresh finished',
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const refreshed = readPersistedBlocks(userDataDir)
      .filter((block) => block.type === 'tool_result')
      .flatMap((block) => {
        try {
          return [JSON.parse(block.output)];
        } catch {
          return [];
        }
      });
    expect
      .soft(
        refreshed
          .find((value) => value.target === 'audit/other.ts::work')
          ?.hits?.map((hit) => hit.qualifiedName),
      )
      .toContain('audit/alias.ts::aliasConsumer');
    expect
      .soft(
        refreshed.some((value) =>
          value.hits?.some(
            (hit) => hit.qualifiedName === 'audit/stat.ts::newName',
          ),
        ),
      )
      .toBe(true);
    expect
      .soft(
        refreshed.find((value) => value.hasGraph === true)?.diagnostics
          ?.freshness,
      )
      .toBe('content');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Real worktree-owned WASM and tags are read by the production build worker.
// Editing only the tags asset must invalidate extraction for unchanged source.
test('injected graph tools build custom WASM and refresh unchanged source after a tags edit', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-custom-grammar-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0].worktreePath;
  const configDir = path.join(worktreePath, '.canopy', 'code-graph');
  mkdirSync(configDir, { recursive: true });
  const resources = path.resolve(
    'packages/desktop-shared/resources/code-graph',
  );
  copyFileSync(
    path.join(resources, 'grammars/tree-sitter-typescript.wasm'),
    path.join(configDir, 'grammar.wasm'),
  );
  const tagsPath = path.join(configDir, 'tags.scm');
  copyFileSync(path.join(resources, 'queries/javascript.tags.scm'), tagsPath);
  writeFileSync(
    path.join(configDir, 'languages.json'),
    JSON.stringify({
      version: 1,
      languages: [
        {
          id: 'zzlang',
          extensions: ['.zz'],
          wasmFile: 'grammar.wasm',
          tagsFiles: ['tags.scm'],
        },
      ],
    }),
  );
  const sourcePath = path.join(worktreePath, 'widget.zz');
  const source =
    'export function widgetMain(): void { helperFn(); }\nfunction helperFn(): void {}\n';
  writeFileSync(sourcePath, source);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
    rules: [],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'custom-grammar', title: 'Custom grammar' }],
  });
  const marker = 'Canopy-CGRAPH-CUSTOM-WASM';
  const initialReply = 'Finished querying the custom grammar';
  const refreshReply = 'Finished refreshing the changed tags';
  const calls = [
    { name: 'BuildOrUpdateCodeGraph', input: {} },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'file-summary',
        target: 'widget.zz',
        detailLevel: 'standard',
      },
    },
    {
      name: 'QueryCodeGraph',
      input: {
        mode: 'callers',
        target: 'widget.zz::helperFn',
        detailLevel: 'standard',
      },
    },
  ];
  const steps = calls.map((call) => ({
    toolCalls: [{ name: `mcp__canopy__${call.name}`, input: call.input }],
    stopReason: 'tool_use',
  }));
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [...steps, { text: initialReply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const dbPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'code-graph',
    'graph.db',
  );
  const readMetadata = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT key, value FROM graph_metadata WHERE key IN ('custom_languages', 'custom_languages_fingerprint')",
        )
        .all();
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    } finally {
      db.close();
    }
  };
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const composer = window.getByRole('textbox').first();
    await composer.fill(`[${marker}] Build and query the custom grammar.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByTestId('panel-content-chat').getByText(initialReply).first(),
    ).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        () =>
          readPersistedBlocks(userDataDir).some(
            (block) => block.type === 'text' && block.text === initialReply,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const initialBlocks = readPersistedBlocks(userDataDir);
    const summary = findToolResultPayload(initialBlocks, '"fileSummary"');
    expect(summary?.status).toBe('ok');
    expect(
      summary?.fileSummary?.symbols.map((symbol) => symbol.qualifiedName),
    ).toEqual(
      expect.arrayContaining(['widget.zz::widgetMain', 'widget.zz::helperFn']),
    );
    // Match the query result rather than the preceding file-summary result.
    const callerPayloads = initialBlocks
      .filter((block) => block.type === 'tool_result')
      .map((block) => JSON.parse(block.output));
    expect(
      callerPayloads
        .find((payload) => payload.mode === 'callers')
        ?.hits.map((hit) => hit.qualifiedName),
    ).toContain('widget.zz::widgetMain');
    const before = readMetadata();
    expect(JSON.parse(before.custom_languages)).toMatchObject({
      loaded: [{ id: 'zzlang' }],
      diagnostics: [],
    });
    expect(before.custom_languages_fingerprint).toBeTruthy();
    writeFileSync(
      tagsPath,
      '((function_declaration name: (identifier) @name) @definition.function (#eq? @name "widgetMain"))\n',
    );
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          ...steps,
          { text: initialReply, stopReason: 'end_turn' },
          ...steps.slice(0, 2),
          { text: refreshReply, stopReason: 'end_turn' },
        ],
      },
    });
    await composer.fill(
      `[${marker}] Rebuild after the tags asset changed and query the unchanged source.`,
    );
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByTestId('panel-content-chat').getByText(refreshReply).first(),
    ).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        () =>
          readPersistedBlocks(userDataDir).some(
            (block) => block.type === 'text' && block.text === refreshReply,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const blocks = readPersistedBlocks(userDataDir);
    const payloads = blocks
      .filter((block) => block.type === 'tool_result')
      .map((block) => JSON.parse(block.output));
    const refreshed = payloads
      .filter((payload) => payload.mode === 'file-summary')
      .at(-1);
    expect(refreshed?.status).toBe('ok');
    expect(
      refreshed?.fileSummary?.symbols.map((symbol) => symbol.qualifiedName),
    ).toEqual(['widget.zz::widgetMain']);
    const after = readMetadata();
    expect(after.custom_languages_fingerprint).not.toBe(
      before.custom_languages_fingerprint,
    );
    expect(JSON.parse(after.custom_languages)).toMatchObject({
      loaded: [{ id: 'zzlang' }],
      diagnostics: [],
    });
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
    const toolResults = blocks.filter((block) => block.type === 'tool_result');
    expect(toolResults).toHaveLength(5);
    expect(toolResults.every((block) => block.isError !== true)).toBe(true);
    await test.info().attach('custom-grammar-worker-and-tool-evidence', {
      body: Buffer.from(
        JSON.stringify(
          {
            before,
            after,
            sourceSha256: createHash('sha256').update(source).digest('hex'),
            wasmSha256: createHash('sha256')
              .update(readFileSync(path.join(configDir, 'grammar.wasm')))
              .digest('hex'),
            toolBlocks: blocks.filter(
              (block) =>
                block.type === 'tool_use' || block.type === 'tool_result',
            ),
          },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
