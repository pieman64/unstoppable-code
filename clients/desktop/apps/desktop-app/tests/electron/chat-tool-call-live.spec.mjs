import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  createConfinementInference,
  seedDelegationConfinementModel,
} from './seeders/delegationConfinement.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readDelegationStreamRows } from './readChatStorage.mjs';

// ---------------------------------------------------------------------------
// Live-turn TOOL LOOP — bundled Claude SDK → mock LLM → in-app MCP tool.
// Doc 5 §5; Doc 2 Spec 4/14.
//
// This builds on the `chat-live-turn.spec.mjs` pilot (which proved a single
// live text turn reaches the mock and streams back). Here the scripted
// conversation is TWO steps and exercises the full provider tool loop:
//
//   step 0 — the mock returns a `tool_use` for `mcp__canopy__GetScriptOutput`
//            with `stopReason: 'tool_use'`. The bundled `claude` binary
//            EXECUTES that tool in-process: it routes to the HTTP MCP proxy
//            (`getMcpHttpProxyService`) →
//            `executeCanopyInjectedTool('get_script_output', ...)` →
//            `loadWorktreeScriptOutput`. The demo worktree has no persisted
//            script output, so the tool returns a deterministic
//            "No persisted output" text result with NO real side effects.
//   step 1 — resolved by assistant-turn count once the tool_result is sent
//            back, the mock returns the follow-up text.
//
// `GetScriptOutput` is the right tool for this spec because its card renders
// from the `tool_use` alone (no UI interaction needed to complete it — the
// ask-user interactive loop is the SIBLING `ask-user-live.spec.mjs`). The
// rendered card label is "Script Output" (see
// packages/ui-shared/src/components/chat/tool-display.tsx `renderGetScriptOutput`).
//
// A green run is proof the bundled Claude SDK drove a real tool call against
// the mock: the asserted card + follow-up text can ONLY come from the live
// two-step loop. See `chat-live-turn.spec.mjs` for the env-hygiene rationale
// behind `withBundledBinaryOverridesScrubbed`.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CTOOLLOOP';
// Distinct scriptId so the rendered tool-call card is unambiguous in the
// transcript. The mock ignores the input; the in-app tool just reports no
// persisted output for it.
const SCRIPT_ID = 'launch';
// No trailing punctuation: assistant text streams into a markdown <span> and a
// trailing '.' is not reliably part of the same matched text node.
const FOLLOW_UP_REPLY = 'Checked the script output and finished the loop';

test.describe('chat tool-call live turn', () => {
  test('a live Claude turn drives an MCP tool call against the mock and renders the card + follow-up', async () => {
    // SDK process spawn + two-turn loop (tool call + follow-up) takes longer
    // than the 60s default; bound it generously.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-tool-call-live-'),
    );

    // Phase 1: real git worktree (plain `ts-pnpm-vite` fixture).
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const reportPath = path.join(
      seeded.workspaces[0].worktreePath,
      'canopy-report.md',
    );
    const resultsPath = path.join(
      seeded.workspaces[0].worktreePath,
      'canopy-results.csv',
    );
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready to
    // send. No seeded transcript blocks — every block asserted below must come
    // from the live turn against the mock.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });

    // Register the two-step tool loop under the `[Canopy-CTOOLLOOP]` marker.
    // Step 0 = tool_use; step 1 (resolved by assistant-turn count after the
    // tool_result returns) = the follow-up text.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__GetScriptOutput',
                input: { scriptId: SCRIPT_ID },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                name: 'Write',
                input: {
                  file_path: reportPath,
                  content: '# Tool output report\n',
                },
              },
              {
                name: 'Write',
                input: { file_path: resultsPath, content: 'result,42\n' },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: FOLLOW_UP_REPLY, stopReason: 'end_turn' },
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

      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // Type the marker-bearing message into the Slate composer and send it.
      const userMessage = `[${CONVERSATION_MARKER}] Read the launch script output.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);

      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders once sent.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live tool loop is the real validator. The bundled `claude` binary
      // POSTs to the mock, the mock emits the `tool_use`, the SDK executes the
      // in-app GetScriptOutput MCP tool, and the tool-call card renders. The
      // card label is "Script Output" with the scriptId as a code chunk.
      await expect(panel.getByText('Script Output').first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(panel.getByText(SCRIPT_ID).first()).toBeVisible({
        timeout: 30_000,
      });

      // After the tool_result is sent back, the mock resolves step 1 (by
      // assistant-turn count) and the follow-up text streams in. This text can
      // ONLY originate from the second turn of the live loop.
      await expect(panel.getByText(FOLLOW_UP_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });

      // Tool-created files must remain reachable from the transcript summary.
      const files = panel.getByTestId('turn-files').last();
      const disclosure = files.locator('button[aria-expanded="false"]');
      if (await disclosure.count()) await disclosure.press('Enter');
      await files
        .getByRole('button', { name: /^(?:Open )?canopy-report\.md$/ })
        .click();
      const viewer = window.getByTestId('file-viewer');
      await expect(viewer).toContainText('canopy-report.md');
      expect(readFileSync(reportPath, 'utf8')).toBe('# Tool output report\n');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('managed Codex delegates preserve selected Git reads but cannot read sibling metadata in either profile', async ({}, testInfo) => {
    test.skip(
      process.platform !== 'darwin',
      'Linked-checkout sibling fence is macOS-only; enable on Linux once requalified. Windows has no OS sandbox.',
    );
    test.setTimeout(60_000);
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-confinement-')),
    );
    const git = (cwd, ...args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    const runsDir = path.join(
      workspaceRoot,
      'worktree-data',
      WORKTREE_ID,
      'delegation',
      'runs',
    );
    const runs = () =>
      existsSync(runsDir)
        ? readdirSync(runsDir)
            .filter((name) => name.endsWith('.json'))
            .map((name) =>
              JSON.parse(readFileSync(path.join(runsDir, name), 'utf8')),
            )
        : [];
    let electronApp;
    let fixture;
    let receipt;
    let commonRoot;
    try {
      // Per-user temp masks this escape: the common .git must be in shared temp.
      commonRoot = realpathSync(mkdtempSync('/private/tmp/canopy-git-'));
      const seeded = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
        fixturesDir: path.join(commonRoot, 'fixtures'),
      });
      const cwd = realpathSync(seeded.workspaces[0].worktreePath);
      const common = git(
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      );
      const selected = git(cwd, 'rev-parse', '--absolute-git-dir');
      expect(common.startsWith(`${commonRoot}/`)).toBe(true);
      expect(common.startsWith('/private/tmp/')).toBe(true);
      expect(cwd.startsWith(`${commonRoot}/`)).toBe(false);
      expect(selected.startsWith(`${common}/worktrees/`)).toBe(true);
      git(cwd, 'config', 'extensions.worktreeConfig', 'true');
      git(cwd, 'config', 'delegation.common', 'COMMON_CONFIG_READABLE');
      git(
        cwd,
        'config',
        '--worktree',
        'delegation.canary',
        'SELECTED_CONFIG_READABLE',
      );
      git(
        cwd,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'HISTORY_READABLE',
      );

      const addSibling = (name, canary) => {
        const sibling = path.join(commonRoot, name);
        const file = path.join(common, 'worktrees', name, 'config.worktree');
        expect(existsSync(path.dirname(file))).toBe(false);
        git(cwd, 'worktree', 'add', '--detach', sibling);
        git(sibling, 'config', '--worktree', 'delegation.canary', canary);
        expect(readFileSync(file, 'utf8')).toContain(canary);
        expect(realpathSync(file.replace('/private/tmp/', '/tmp/'))).toBe(file);
      };
      addSibling('existing', 'EXISTING_PRIVATE_CANARY');
      const cases = ['delegated_read_only', 'delegated_write'].map(
        (profile) => {
          const lateName = `late-${profile}`;
          const sourceFile = `delegation-${profile}.txt`;
          const command = [
            'git log -1 --format=%s',
            'git config --get delegation.common',
            'git config --worktree --get delegation.canary',
            ...['existing', lateName].flatMap((name) => {
              const file = path.join(
                common,
                'worktrees',
                name,
                'config.worktree',
              );
              return [file, file.replace('/private/tmp/', '/tmp/')].map(
                (spelling, index) =>
                  `if value=$(LC_ALL=C cat ${quote(spelling)} 2>&1); then printf '%s\\n' "SIBLING_EXPOSED_${name}_${index}:$value"; else case "$value" in *'Permission denied'*|*'Operation not permitted'*) echo SIBLING_DENIED_${name}_${index};; *) printf '%s\\n' "SIBLING_PROBE_FAILED_${name}_${index}:$value";; esac; fi`,
              );
            }),
            `if (printf 'confined write\\n' > ${quote(sourceFile)}) 2>/dev/null; then echo SOURCE_WRITE_ALLOWED; else echo SOURCE_WRITE_DENIED; fi`,
          ].join('\n');
          return {
            profile,
            lateName,
            sourceFile,
            command,
            marker: `Canopy-CNATIVECHILD-${profile}`,
            finding: `Inspected checkout with ${profile}`,
          };
        },
      );
      fixture = await createConfinementInference({
        cases,
        // Each profile gets a sibling created after its own thread preparation.
        onFirstChildRequest: (entry) =>
          addSibling(entry.lateName, 'LATE_PRIVATE_CANARY'),
      });
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        defaultMode: 'full-access',
      });
      writeFileSync(
        path.join(userDataDir, 'preferences.json'),
        JSON.stringify({
          version: 1,
          preferences: {
            managedDelegationMode: 'explicit-only',
            onboardingCompleted: ['v1'],
            defaultChatInterfaceMode: 'canopy',
            defaultWorktreeProvider: 'claude',
            defaultChatProvider: 'claude',
            codexMultiAgentWorktreeChatsEnabled: false,
          },
        }),
      );
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        tabs: [
          {
            id: 'confinement-parent',
            title: 'Chat',
            providerType: 'claude',
            executionHarness: 'claude',
            model: 'claude-sonnet-4-6',
            approvalMode: 'full-access',
          },
        ],
      });
      ({ electronApp } = await withBundledBinaryOverridesScrubbed(async () => {
        seedDelegationConfinementModel(userDataDir);
        return launchCanopy({
          userDataDir,
          env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
        });
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window
        .getByRole('textbox')
        .first()
        .fill(`[${fixture.marker}] Delegate both checkout inspections.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(
          () => runs().filter((run) => run.state.status === 'completed').length,
          { timeout: 35_000 },
        )
        .toBe(2);

      const completed = runs();
      receipt = cases.map((entry) => {
        const run = completed.find(
          (candidate) => candidate.state.finalText === entry.finding,
        );
        const rows =
          run?.version === 3
            ? readDelegationStreamRows(workspaceRoot, WORKTREE_ID, {
                chatId: run.parent.chatId,
                delegationId: run.state.delegationId,
                runGeneration: run.state.runGeneration,
              })
            : [];
        const blocks =
          run?.version === 3
            ? rows.flatMap((row) => row.blocks)
            : (run?.state.transcript ?? []);
        return {
          entry,
          run,
          rows,
          blocks,
          observation: fixture.observations.get(entry.profile),
        };
      });
      expect(fixture.errors).toEqual([]);
      expect(completed).toHaveLength(2);
      for (const { entry, run, rows, blocks, observation } of receipt) {
        expect(run).toBeTruthy();
        expect(run.route.harnessId).toBe('codex');
        expect(run.route.runtimeKind).toBe('codex-app-server');
        expect(run.state.nativeSessionId).toBeTruthy();
        expect(observation.firstRequestAt).toBeGreaterThanOrEqual(
          run.state.startedAt,
        );
        const probeOccurredAt =
          run.version === 3
            ? rows.find((row) =>
                row.blocks.some(
                  (block) =>
                    block.type === 'tool_use' &&
                    block.toolName === 'command' &&
                    block.input.includes(entry.sourceFile),
                ),
              )?.timestamp
            : blocks.find((block) => block.type === 'tool')?.occurredAt;
        expect(probeOccurredAt).toBeGreaterThanOrEqual(
          observation.lateCreatedAt,
        );
        const durableOutput = blocks
          .filter(
            (block) => block.type === 'tool' || block.type === 'tool_result',
          )
          .map((block) => block.output ?? '')
          .join('\n');
        for (const [source, output] of [
          ['child', observation.results.join('\n')],
          ['durable', durableOutput],
        ]) {
          // Report both profiles even when the first one exposes metadata.
          const observed = expect.soft(output, `${entry.profile}: ${source}`);
          for (const token of [
            'HISTORY_READABLE',
            'COMMON_CONFIG_READABLE',
            'SELECTED_CONFIG_READABLE',
          ])
            observed.toContain(token);
          for (const name of ['existing', entry.lateName]) {
            for (const spelling of [0, 1])
              observed.toContain(`SIBLING_DENIED_${name}_${spelling}`);
          }
          observed.not.toMatch(
            /SIBLING_EXPOSED|SIBLING_PROBE_FAILED|EXISTING_PRIVATE_CANARY|LATE_PRIVATE_CANARY/,
          );
          observed.toContain(
            entry.profile === 'delegated_write'
              ? 'SOURCE_WRITE_ALLOWED'
              : 'SOURCE_WRITE_DENIED',
          );
        }
        const file = path.join(cwd, entry.sourceFile);
        if (entry.profile === 'delegated_write')
          expect(readFileSync(file, 'utf8')).toBe('confined write\n');
        else expect(existsSync(file)).toBe(false);
      }
      await expect(window.getByTestId('panel-content-chat')).toContainText(
        'Finished both confined inspections',
      );
    } finally {
      // Seal evidence before closeCanopy removes durable child streams.
      try {
        await testInfo.attach('native-confinement.json', {
          body: JSON.stringify(
            {
              receipt,
              runs: runs(),
              observations: fixture ? [...fixture.observations] : [],
              errors: fixture?.errors,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        });
      } finally {
        try {
          if (electronApp) await closeCanopy(electronApp, userDataDir);
        } finally {
          try {
            await fixture?.close();
          } finally {
            if (commonRoot)
              rmSync(commonRoot, { recursive: true, force: true });
            rmSync(userDataDir, { recursive: true, force: true });
          }
        }
      }
    }
  });
});
