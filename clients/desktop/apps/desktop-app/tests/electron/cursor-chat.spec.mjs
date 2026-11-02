import {
  selectModelOnHarness,
  selectModelOption,
} from './model-selection-fixture.mjs';
import {
  chmodSync,
  symlinkSync,
  cpSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openPipelineAssistant } from './pipelineAssistant.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  seedCoworkWorkspace,
  seedPluginsCache,
  seedWorktreeChat,
  registerScenario,
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';
import { createServer } from 'node:http';
import { seedMcpServers } from './seeders/index.mjs';
import { offeredBillingMenus } from './modelPickerBilling.mjs';
import {
  closeEffortPanel,
  openEffortSlider,
  readEffortStops,
  stepEffortAway,
} from './effortPanel.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

// Cursor keeps its per-chat CLI profile under the worktree's data directory so
// worktree deletion removes it; every scenario here seeds the same pair.
const cursorSessionsDir = (userDataDir) =>
  path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
    'cursor-sessions',
  );

// Cowork Cursor profiles live under the Work Entry's data directory.
const coworkCursorSessionsDirs = (userDataDir) => {
  const root = path.join(
    userDataDir,
    'workspaces',
    'seeded-cowork',
    'worktree-data',
  );
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => path.join(root, entry, 'cursor-sessions'))
    .filter((dir) => existsSync(dir));
};

async function connectCursor(window, driver) {
  await driver.openSettings();
  await driver.openSettingsSection('experiments');
  await window.getByTestId('cursor-connect').click();
  await expectCursorConnected(window);
  await driver.closeSettings();
}

const live = Boolean(process.env.CURSOR_CHAT_LIVE_BINARY);

for (const mode of ['timeout-once', 'exit']) {
  test(`Cursor version probe ${mode} recovers without reinstalling CAN-4031`, async () => {
    test.skip(live, 'Deterministic version probe regression');
    test.setTimeout(120_000);
    const root = mkdtempSync(path.join(os.tmpdir(), 'cursor-version-probe-'));
    const probeFile = path.join(root, 'probe.json');
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture({
      runtimeEnv: { CANOPY_E2E_CURSOR_VERSION_PROBE_FILE: probeFile },
    });
    try {
      await f.connection(true);
      await f.openChat();
      const panel = f.window.getByTestId('panel-content-chat');
      await panel.getByTestId('chat-model-picker').click();
      await f.window.getByTestId('chat-model-option-cursor-default').click();
      writeFileSync(probeFile, JSON.stringify({ mode }));
      const send = async () => {
        await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_TEXT');
        await panel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
      };
      await send();
      if (mode === 'exit') {
        await expect(
          panel.getByText(
            'The Cursor version check exited before it completed. Try again.',
            { exact: false },
          ),
        ).toBeVisible();
        await expect(
          panel.getByText(/reinstall the pinned runtime/),
        ).toHaveCount(0);
        expect(JSON.parse(readFileSync(probeFile, 'utf8')).attempts).toBe(1);
        rmSync(probeFile);
        await send();
      }
      await expect(
        panel.getByText('Cursor chat works.', { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
      await expect
        .poll(() =>
          readFileSync(path.join(f.userDataDir, 'logs', 'main.log'), 'utf8'),
        )
        .toContain(mode === 'exit' ? 'process-exit' : 'timeout');
      if (mode === 'timeout-once') {
        expect(JSON.parse(readFileSync(probeFile, 'utf8')).attempts).toBe(2);
      }
    } finally {
      await f.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [kind, shape] of ['read', 'search', 'fetch'].flatMap((kind) =>
  ['update', 'initial'].map((shape) => [kind, shape]),
)) {
  test(`Cursor stops an unhooked ${kind} ${shape} completion and can resume`, async () => {
    test.skip(live, 'Deterministic missing-hook regression');
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture();
    try {
      await f.connection(true);
      await f.driver.openMainPage();
      await f.driver.selectWorktree('demo-main', {
        expandDefaultActivityRail: false,
      });
      const panel = f.window.getByTestId('panel-content-chat');
      await panel.getByTestId('chat-model-picker').click();
      await f.window.getByTestId('chat-model-option-cursor-default').click();
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          `CURSOR_CHAT_E2E_COMPLETION:${kind}:none${shape === 'initial' ? ':initial' : ''}`,
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText(/Cursor ran a tool without reaching the approval hook/),
      ).toBeVisible();
      await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
      expect(
        await f.window.evaluate(() => window.api.approvals.pendingRequests()),
      ).toEqual([]);
      await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_RESUME');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText('CANOPY_CURSOR_REMEMBERED', { exact: true }),
      ).toBeVisible();
      await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    } finally {
      await f.close();
    }
  });
}

test('creates a custom Cursor Agent, restores its instructions, and delegates to it', async () => {
  test.skip(live, 'Deterministic custom Agent scenario');
  test.setTimeout(180_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ approvalMode: 'full-access' });
  const agentId = 'agent_model_cursor_reviewer';
  try {
    await f.connection(true);
    await f.driver.openMarketplaceAgents();
    await f.driver.createMarketplaceAgent();
    const modal = f.window.getByTestId('agent-model-modal');
    await modal.getByTestId('agent-model-name').fill('Cursor reviewer');
    await modal.getByTestId('chat-model-picker').click();
    await expect(
      f.window.getByTestId('chat-model-option-cursor-default'),
    ).toBeVisible();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    await modal
      .getByTestId('agent-model-instructions')
      .fill('CUSTOM_CURSOR_REVIEW_INSTRUCTIONS');
    await modal.getByTestId('agent-model-submit').click();
    await expect(modal).toBeHidden();
    await f.driver.expectCreatedLocalAgentDetail(agentId);
    await f.restart();
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId(`chat-model-option-${agentId}`).click();
    await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_TEXT');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    const profiles = cursorSessionsDir(f.userDataDir);
    const prompts = readdirSync(profiles)
      .map((name) => path.join(profiles, name, 'fixture-prompt.txt'))
      .filter(existsSync);
    expect(prompts).toHaveLength(1);
    expect(readFileSync(prompts[0], 'utf8')).toContain(
      'CUSTOM_CURSOR_REVIEW_INSTRUCTIONS',
    );
    expect(await f.tab()).toMatchObject({
      model: agentId,
      providerType: 'cursor',
    });
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await chooseSettingsOption(
      f.window.getByTestId('settings-managed-delegation-mode'),
      'explicit-only',
    );
    await f.driver.closeSettings();
    writeFileSync(
      path.join(f.worktreePath, 'delegation-evidence.txt'),
      'CUSTOM_AGENT_DELEGATED_EVIDENCE',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill(`CURSOR_DELEGATION_PARENT CURSOR_CHILD_MODEL=${agentId}`);
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(
        /Integrated delegated evidence:.*CUSTOM_AGENT_DELEGATED_EVIDENCE/,
      ),
    ).toBeVisible({ timeout: 90_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    const delegationDir = path.join(
      f.userDataDir,
      'workspaces',
      f.target.projectId,
      'worktree-data',
      f.target.worktreeId,
      'delegation',
    );
    const runs = readdirSync(path.join(delegationDir, 'runs')).filter((name) =>
      name.endsWith('.json'),
    );
    expect(runs).toHaveLength(1);
    const run = JSON.parse(
      readFileSync(path.join(delegationDir, 'runs', runs[0]), 'utf8'),
    );
    expect(run.state.status).toBe('completed');
    expect(
      readFileSync(
        path.join(
          delegationDir,
          'cursor-sessions',
          run.state.delegationId,
          'fixture-prompt.txt',
        ),
        'utf8',
      ),
    ).toContain('CUSTOM_CURSOR_REVIEW_INSTRUCTIONS');
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            delegationDir,
            'cursor-sessions',
            run.state.delegationId,
            'fixture-search-decisions.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ Grep: 'deny', Glob: 'deny', List: 'deny', ReadLints: 'deny' });
  } finally {
    await f.close();
  }
});

test('Cursor delegates to a Cursor child, integrates its result, and disconnects after failed cleanup', async () => {
  test.skip(live, 'Deterministic managed delegation scenario');
  test.setTimeout(180_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({
    approvalMode: 'full-access',
    runtimeEnv: { CANOPY_E2E_FORCE_DELEGATION_REVOCATION_FAILURE: '1' },
  });
  try {
    await f.connection(true);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await chooseSettingsOption(
      f.window.getByTestId('settings-managed-delegation-mode'),
      'explicit-only',
    );
    await f.driver.closeSettings();
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    // The fixture returns the seeded checkout directly; no app API is replaced.
    writeFileSync(
      path.join(f.worktreePath, 'delegation-evidence.txt'),
      'CURSOR_DELEGATED_EVIDENCE',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        'Please delegate this review. CURSOR_DELEGATION_PARENT CURSOR_DELEGATION_ACP',
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(panel.getByTestId('chat-delegated-agent').first()).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(
      panel.getByText(
        /Integrated delegated evidence:.*CURSOR_DELEGATED_EVIDENCE/,
      ),
    ).toBeVisible({ timeout: 90_000 });
    await expect(panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.window.reload();
    await f.driver.waitForShell();
    await f.openChat();
    await panel
      .getByRole('button', { name: /^Agent steps:/, expanded: false })
      .first()
      .click();
    await expect(
      panel.getByTestId('chat-delegated-agent').first(),
    ).toBeVisible();
    writeFileSync(
      path.join(f.worktreePath, 'delegation-evidence.txt'),
      'CURSOR_FOLLOW_UP_EVIDENCE',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_DELEGATION_FOLLOW_UP');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(
        /Integrated delegated evidence:.*CURSOR_FOLLOW_UP_EVIDENCE/,
      ),
    ).toBeVisible({ timeout: 60_000 });
    await panel.getByRole('textbox').first().fill('CURSOR_DELEGATION_STOP');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const delegationDir = path.join(
      f.userDataDir,
      'workspaces',
      f.target.projectId,
      'worktree-data',
      f.target.worktreeId,
      'delegation',
    );
    const retained = () =>
      readdirSync(path.join(delegationDir, 'runs'))
        .filter((name) => name.endsWith('.json'))
        .map((name) =>
          JSON.parse(
            readFileSync(path.join(delegationDir, 'runs', name), 'utf8'),
          ),
        )[0];
    await expect
      .poll(
        () => {
          const state = retained().state;
          if (state.runGeneration !== 3 || state.status !== 'running')
            return false;
          const promptFile = path.join(
            delegationDir,
            'cursor-sessions',
            state.delegationId,
            'fixture-prompt.txt',
          );
          return (
            existsSync(promptFile) &&
            readFileSync(promptFile, 'utf8')
              .trimEnd()
              .endsWith('CURSOR_DELEGATION_CHILD_WAIT')
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const pid = Number(
      readFileSync(
        path.join(
          delegationDir,
          'cursor-sessions',
          retained().state.delegationId,
          'fixture-pid.txt',
        ),
        'utf8',
      ),
    );
    // The composer Stop only detaches delegates; the task row's Stop is the
    // user's way to cancel the child itself.
    const rowStop = panel.getByTestId('delegated-agent-stop').first();
    await expect(rowStop).toHaveAccessibleName('Stop delegation');
    await rowStop.click();
    await expect.poll(() => retained().state.status).toBe('cancelled');
    expect(retained().state).toMatchObject({
      stopReason: 'user_cancelled',
      cancelledByUser: true,
    });
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    // A failed child shutdown must not leave the account enabled or its models
    // selectable. This goes through the real App Advisor disconnect action,
    // the Settings panel's handler, and the IPC handler.
    await f.connection(false);
    expect(
      await f.window.evaluate(() => window.api.loadPreferences()),
    ).toMatchObject({
      cursorEnabled: false,
      cursorAgentPath: '',
    });
    expect(
      readFileSync(path.join(f.userDataDir, 'logs', 'main.log'), 'utf8'),
    ).toContain('E2E forced incomplete delegation revocation');
  } finally {
    await f.close();
  }
});

// Exercise the real provider runners and broker; only inference is scripted.
for (const native of ['claude', 'codex']) {
  for (const cursorParent of [false, true]) {
    test(`Cursor cross-provider delegation: ${cursorParent ? 'cursor' : native} to ${cursorParent ? native : 'cursor'}`, async () => {
      test.skip(live, 'Deterministic cross-provider delegation');
      test.setTimeout(180_000);
      const { createDelegationInference } =
        await import('./delegationRuntime.mjs');
      const { launchCursorSelectionFixture } =
        await import('./fixtures/cursor-selection.mjs');
      const caseId = `cursor-cross-${native}-${cursorParent ? 'parent' : 'child'}`;
      const inference = await createDelegationInference({
        parent: native,
        child: native,
        mode: 'foreground',
        caseId,
        script(ctx) {
          if (cursorParent || ctx.role !== 'parent') return;
          const call = (name, input) =>
            ctx.reply({ toolCalls: [{ name, input }], stopReason: 'tool_use' });
          if (!ctx.results) {
            return call(
              ctx.spawnTool,
              native === 'claude'
                ? {
                    model: 'cursor-default',
                    description: 'Cursor evidence review',
                    prompt: 'CURSOR_DELEGATION_CHILD_READ',
                  }
                : {
                    model: 'cursor-default',
                    task_name: 'cursor_review',
                    message: 'CURSOR_DELEGATION_CHILD_READ',
                    execution_mode: 'foreground',
                  },
            );
          }
          const id = ctx.results.match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
          )?.[0];
          if (ctx.results.includes(ctx.finding))
            return ctx.reply({ text: ctx.integrated, stopReason: 'end_turn' });
          if (!id)
            return ctx.reply({
              text: `Delegation failed: ${ctx.results}`,
              stopReason: 'end_turn',
            });
          if (ctx.item.hasDelegateNotice)
            return call(
              ctx.toolName('GetDelegateOutput', 'get_delegate_output'),
              { delegationId: id },
            );
          return ctx.reply({
            text: 'Waiting for the delegated result.',
            stopReason: 'end_turn',
          });
        },
      });
      const f = await launchCursorSelectionFixture({
        approvalMode: 'full-access',
        runtimeEnv: { CANOPY_MOCK_LLM_BASE_URL: inference.url },
      });
      try {
        await f.connection(true);
        await f.driver.openSettings();
        await f.driver.openSettingsSection('experiments');
        await chooseSettingsOption(
          f.window.getByTestId('settings-managed-delegation-mode'),
          'explicit-only',
        );
        await f.driver.closeSettings();
        await f.openChat();
        const panel = f.window.getByTestId('panel-content-chat');
        await panel.getByTestId('chat-model-picker').click();
        const model = cursorParent
          ? 'cursor-default'
          : native === 'claude'
            ? 'sonnet'
            : 'gpt-6.1-sol';
        await selectModelOption(f.window, model);
        writeFileSync(
          path.join(f.worktreePath, 'delegation-evidence.txt'),
          `${inference.canary}\n${inference.finding}`,
        );
        const prompt = cursorParent
          ? `Please delegate. CURSOR_DELEGATION_PARENT CURSOR_CHILD_MODEL=${native === 'claude' ? 'sonnet' : 'gpt-6.1-sol'} [Canopy-CDELEGATIONCHILD-${caseId}]`
          : `[${inference.parentMarker}] Please delegate the evidence review.`;
        await panel.getByRole('textbox').first().fill(prompt);
        await panel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect(
          panel.getByText(
            cursorParent
              ? new RegExp(
                  `Integrated delegated evidence:.*${inference.finding}`,
                )
              : inference.integrated,
            { exact: !cursorParent },
          ),
        ).toBeVisible({ timeout: 120_000 });
        expect(
          inference.requests.some(
            (request) => request.role === (cursorParent ? 'child' : 'parent'),
          ),
        ).toBe(true);
      } finally {
        await f.close();
        await inference.close();
      }
    });
  }
}

test('Cursor preserves an immediate text and tool burst through reload', async () => {
  test.skip(live, 'Deterministic concurrent ACP updates');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  try {
    await f.window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_ORDERED_BURST');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('After the ordered read.', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    for (const reload of [false, true]) {
      if (reload) {
        await f.window.reload();
        await f.driver.waitForShell();
        await f.openChat();
      }
      const steps = panel.getByRole('button', { name: /^Agent steps:/ });
      if ((await steps.getAttribute('aria-expanded')) === 'false')
        await steps.click();
      await expect(
        panel.getByText('Before the ordered read.', { exact: true }),
      ).toBeVisible();
      await expect(panel.locator('[data-tool-name="Read"]')).toContainText(
        'ordered-read.txt',
      );
      const tab = await f.tab();
      const blocks = tab.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.blocks ?? []);
      expect(
        blocks
          .filter((block) =>
            ['text', 'tool_use', 'tool_result'].includes(block.type),
          )
          .map((block) => block.type),
      ).toEqual(['text', 'tool_use', 'tool_result', 'text']);
      expect(
        blocks.find((block) => block.type === 'tool_result').output,
      ).toContain('Ordered file content.');
    }
  } finally {
    await f.close();
  }
});

test('Cursor keeps the turn working until the entire burst answer is delivered', async () => {
  test.skip(live, 'Deterministic burst of ACP text chunks');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    await f.window.evaluate((target) => {
      window.cursorPrematureCompletions = [];
      window.cursorPrematureIdle = [];
      window.cursorActivityCheck = undefined;
      window.cursorOutputObserver = new MutationObserver(() => {
        const text =
          document.querySelector('[data-testid="panel-content-chat"]')
            ?.textContent ?? '';
        if (/Completed in/.test(text) && !text.includes('CURSOR_STREAM_DONE'))
          window.cursorPrematureCompletions.push(text.slice(-250));
        if (
          text.includes('word-0') &&
          !text.includes('CURSOR_STREAM_DONE') &&
          !window.cursorActivityCheck
        ) {
          window.cursorActivityCheck = window.api.chat
            .activeSessions(target)
            .then((active) => {
              const current =
                document.querySelector('[data-testid="panel-content-chat"]')
                  ?.textContent ?? '';
              if (
                !current.includes('CURSOR_STREAM_DONE') &&
                !active.activeChatIds.includes(target.chatId)
              )
                window.cursorPrematureIdle.push(current.slice(-250));
            })
            .finally(() => {
              window.cursorActivityCheck = undefined;
            });
        }
      });
      window.cursorOutputObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, f.target);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_OUTPUT_BURST');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(panel.getByText(/word-0 word-1/)).toContainText(
      'CURSOR_STREAM_DONE',
      { timeout: 90_000 },
    );
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    const premature = await f.window.evaluate(async () => {
      window.cursorOutputObserver.disconnect();
      await window.cursorActivityCheck;
      return [
        ...window.cursorPrematureCompletions,
        ...window.cursorPrematureIdle,
      ];
    });
    expect(premature).toEqual([]);
    await f.window.reload();
    await f.driver.waitForShell();
    await f.openChat();
    await expect(
      f.window.getByTestId('panel-content-chat').getByText(/word-0 word-1/),
    ).toHaveText(
      `${Array.from({ length: 120 }, (_, i) => `word-${i} `).join('')}CURSOR_STREAM_DONE`,
    );
  } finally {
    await f.close();
  }
});

test('Cursor hides the local-memory citation tag live and after reload', async () => {
  test.skip(live, 'Deterministic ACP text chunks carrying the citation tag');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-cursor-default').click();
    await panel.getByRole('textbox').first().fill('CURSOR_CHAT_E2E_CITATION');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    // The reply text lands on the first delta, so wait for the turn to
    // finish (timer text, then no Stop button) before asserting on the
    // final text; otherwise the live pass could run before the tag deltas.
    await expect(
      panel.getByText('Cited answer.', { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      panel.locator('[data-testid="turn-timer"][data-state="completed"]'),
    ).toBeVisible();
    for (const reload of [false, true]) {
      if (reload) {
        await f.window.reload();
        await f.driver.waitForShell();
        await f.openChat();
        await expect(
          panel.locator('[data-testid="turn-timer"][data-state="completed"]'),
        ).toBeVisible();
      }
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByText('Cited answer.', { exact: true }),
      ).toBeVisible();
      await expect(panel).not.toContainText('memory_citation');
    }
  } finally {
    await f.close();
  }
});

// A Cursor turn runs at the effort the composer shows, so the fixture reports
// the advertised variant with that reasoning value (`off` is Cursor's `none`).
const cursorReasoningFor = (level) => (level === 'off' ? 'none' : level);
// The Home draft and the chat composer render the same shared control under
// their own stable test ids.
const thinkingChipOn = (surface) =>
  surface.locator(
    '[data-testid="home-thinking-level-button"], [data-testid="chat-input-thinking-level-button"]',
  );
async function cursorReasoningShownOn(surface) {
  return cursorReasoningFor(
    await thinkingChipOn(surface).getAttribute('data-thinking-level'),
  );
}

test('Cursor notices remain visible in a completed collapsed turn after reload', async () => {
  test.skip(
    live,
    'Deterministic missing session and unsupported MCP capability',
  );
  const { launchCursorTranscriptFixture } =
    await import('./fixtures/cursor-transcript.mjs');
  const f = await launchCursorTranscriptFixture({ notices: true });
  try {
    await f.complete();
    const steps = f.panel.getByRole('button', { name: /^Agent steps:/ });
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    await steps.click();
    for (const reload of [false, true]) {
      if (reload) {
        await f.window.reload();
        await f.driver.waitForShell();
        await f.openChat();
      }
      await expect(
        f.panel.getByRole('button', { name: /^Agent steps:/ }),
      ).toHaveAttribute('aria-expanded', 'false');
      await expect(
        f.panel.getByText('Earlier Cursor context could not be restored', {
          exact: false,
        }),
      ).toBeVisible();
      await expect(
        f.panel.getByText(
          'Some selections are not available in Cursor chats:',
          { exact: false },
        ),
      ).toBeVisible();
      await expect(
        f.panel.getByText('This is a TypeScript project.', { exact: true }),
      ).toBeVisible();
    }
  } finally {
    await f.close();
  }
});

test('Cursor keeps Read and Edit cards when the provider reuses a tool ID', async () => {
  test.skip(live, 'Deterministic pinned ACP reused tool ID');
  const { launchCursorTranscriptFixture } =
    await import('./fixtures/cursor-transcript.mjs');
  const f = await launchCursorTranscriptFixture({ reused: true });
  try {
    await f.panel.getByTestId('tool-approval-allow').click();
    await expect(f.panel.getByTestId('tool-approval-card')).toContainText(
      'git status',
    );
    await f.complete();
    const steps = f.panel.getByRole('button', { name: /^Agent steps:/ });
    if ((await steps.getAttribute('aria-expanded')) !== 'true') {
      await steps.click();
    }
    const read = f.panel.locator('[data-tool-name="Read"]');
    const edit = f.panel.locator('[data-tool-name="Edit"]');
    await expect(read).toBeVisible();
    await expect(edit).toBeVisible();
    await read.getByRole('button').click();
    await expect(read).toContainText('demo-project');
    await edit.getByRole('button').click();
    await expect(edit).toContainText('package changed');
  } finally {
    await f.close();
  }
});

test('Cursor native tool cards use canonical names and failure states', async () => {
  test.skip(live, 'Deterministic pinned ACP transcript shapes');
  const { launchCursorTranscriptFixture } =
    await import('./fixtures/cursor-transcript.mjs');
  const f = await launchCursorTranscriptFixture();
  try {
    // Clean rows retain canonical tool identity; the retired visual-family
    // attribute is no longer part of the transcript DOM.
    for (const name of ['Read', 'Glob', 'Grep', 'Bash']) {
      const card = f.panel.locator(`[data-tool-name="${name}"]`);
      await expect(card).toBeVisible();
      await expect(card.locator('[data-step-row]')).toBeVisible();
    }
    await expect(f.panel.locator('[data-tool-name="Read"]')).toContainText(
      'package.json',
    );
    const glob = f.panel.locator('[data-tool-name="Glob"]');
    await expect(glob).toHaveAttribute('data-tool-status', 'error');
    await glob.getByRole('button').click();
    await expect(glob).toContainText('Glob blocked by preToolUse hook');
    await f.complete();
  } finally {
    await f.close();
  }
});

for (const tool of [
  'Grep',
  'Glob',
  'List',
  'ReadLints',
  'Delete',
  'Fetch',
  'WebSearch',
]) {
  for (const decision of ['allow', 'deny']) {
    test(`Cursor native ${tool}: ${decision} governs execution`, async () => {
      test.skip(live, 'Deterministic native tool inputs and isolated effects');
      const { launchCursorNativeToolFixture } =
        await import('./fixtures/cursor-native-tools.mjs');
      const f = await launchCursorNativeToolFixture(tool);
      try {
        const card = f.panel.getByTestId('tool-approval-card');
        await expect(card).toContainText(`Cursor wants to use ${tool}`);
        expect(existsSync(f.effectFile)).toBe(false);
        if (tool === 'Delete')
          expect(
            existsSync(path.join(f.worktreePath, 'cursor-native-delete.txt')),
          ).toBe(true);
        await card.getByTestId(`tool-approval-${decision}`).click();
        await expect(
          f.panel.getByText(
            `${tool} ${decision === 'allow' ? 'completed' : 'denied'}.`,
            { exact: true },
          ),
        ).toBeVisible();
        expect(existsSync(f.effectFile)).toBe(decision === 'allow');
        if (tool === 'Delete')
          expect(
            existsSync(path.join(f.worktreePath, 'cursor-native-delete.txt')),
          ).toBe(decision !== 'allow');
        if (tool === 'Grep' && decision === 'allow')
          expect(readFileSync(f.effectFile, 'utf8')).toContain(
            'native search needle',
          );
        if (tool === 'Glob' && decision === 'allow')
          expect(readFileSync(f.effectFile, 'utf8')).toContain(
            'cursor-native-source.txt',
          );
      } finally {
        await f.close();
      }
    });
  }
}

for (const decision of ['allow', 'deny']) {
  test(`Cursor recovers from invalid Grep arguments and still enforces ${decision}`, async () => {
    test.skip(
      live,
      'Pinned validation rejection followed by a hook-backed search',
    );
    const { launchCursorNativeToolFixture } =
      await import('./fixtures/cursor-native-tools.mjs');
    const f = await launchCursorNativeToolFixture('Grep', {
      invalidGrepFirst: true,
    });
    try {
      const card = f.panel.getByTestId('tool-approval-card');
      await expect(card).toContainText('Cursor wants to use Grep');
      expect(existsSync(f.effectFile)).toBe(false);
      await card.getByTestId(`tool-approval-${decision}`).click();
      await expect(
        f.panel.getByText(
          `Grep ${decision === 'allow' ? 'completed' : 'denied'}.`,
          { exact: true },
        ),
      ).toBeVisible();
      expect(existsSync(f.effectFile)).toBe(decision === 'allow');
      await expect(
        f.panel.getByText(/without reaching the approval hook/),
      ).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}

for (const tool of ['Grep', 'Glob']) {
  test(`Cursor native ${tool} works in Full Access and read-only plan mode`, async () => {
    test.skip(live, 'Deterministic native search inputs');
    const { launchCursorNativeToolFixture } =
      await import('./fixtures/cursor-native-tools.mjs');
    const f = await launchCursorNativeToolFixture(tool, {
      approvalMode: 'full-access',
      planMode: true,
    });
    try {
      await expect(
        f.panel.getByText(`${tool} completed.`, { exact: true }),
      ).toBeVisible();
      await expect(f.panel.getByTestId('tool-approval-card')).toHaveCount(0);
      expect(existsSync(f.effectFile)).toBe(true);
    } finally {
      await f.close();
    }
  });
}

test('Cursor completed turn collapses activity and restores its final answer', async () => {
  test.skip(live, 'Deterministic pinned ACP transcript shapes');
  const { launchCursorTranscriptFixture } =
    await import('./fixtures/cursor-transcript.mjs');
  const f = await launchCursorTranscriptFixture();
  try {
    await f.complete();
    const summary = f.panel.getByRole('button', { name: /^Agent steps:/ });
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(summary).toHaveAccessibleName(/Read 1 file/);
    await expect(summary).toHaveAccessibleName(/Ran 1 command/);
    await expect(
      f.panel.getByText('Checking the project files.', { exact: true }),
    ).toHaveCount(0);
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(
      f.panel.getByText('Checking the project files.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.locator('[data-tool-name="Read"]')).toBeVisible();
    await summary.click();
    await f.window.reload();
    await f.driver.waitForShell();
    await f.openChat();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(
      f.panel.getByText('This is a TypeScript project.', { exact: true }),
    ).toBeVisible();
    await expect(
      f.panel.getByText('Checking the project files.', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await f.close();
  }
});
for (const forkMode of [
  'anchored',
  'whole-chat',
  'attachments',
  'max_tokens',
  'max_turn_requests',
  'ordinary',
]) {
  test(`Cursor fork retains context independently and resumes it after restart: ${forkMode}`, async () => {
    test.skip(live, 'Deterministic provider-side conversation storage');
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-fork-e2e-'));
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'cursor',
      tabs: [
        {
          id: 'cursor-source',
          title: 'Cursor source',
          model: 'cursor-default',
          hasStartedSession: true,
          ...(['whole-chat', 'attachments'].includes(forkMode)
            ? {
                messages: [
                  {
                    id: 'attachment-only',
                    role: 'user',
                    timestamp: 1,
                    blocks: [],
                    attachmentPaths: ['/tmp/cursor-fork-attachment.pdf'],
                  },
                ],
              }
            : {}),
        },
      ],
    });
    const managed = await cursorRuntimeFixture();
    let launched = await launchCanopy({ userDataDir, env: managed.env });
    const send = async (panel, prompt, expected) => {
      const previousReplies = await panel
        .getByText(expected, { exact: true })
        .count();
      await panel.getByRole('textbox').first().fill(prompt);
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(panel.getByText(expected, { exact: true })).toHaveCount(
        previousReplies + 1,
        { timeout: 20_000 },
      );
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
    };
    try {
      let window = await launched.electronApp.firstWindow();
      let driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      await driver.closeSettings();
      await driver.openMainPage();
      await driver.selectWorktree('demo-main');
      let panel = window.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-source"]',
      );
      await send(
        panel,
        'CURSOR_CHAT_E2E_CONTEXT_SET: ORCHID-62',
        'Context code: ORCHID-62.',
      );
      if (forkMode === 'whole-chat') {
        const result = await window.evaluate(() =>
          window.api.chat.command({
            schemaVersion: 1,
            commandId: 'cursor-whole-chat-fork',
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
            command: {
              type: 'chat.fork_tab',
              sourceTabId: 'cursor-source',
              targetTabId: 'cursor-whole-fork',
            },
          }),
        );
        expect(result.outcome).toBe('applied');
        await window
          .getByTestId('panel-tab-panel-chat-cursor-whole-fork')
          .click();
      } else {
        await panel
          .getByRole('button', { name: 'Fork chat', exact: true })
          .last()
          .click();
      }
      const scope = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
      const fork = (
        await window.evaluate((scope) => window.api.chat.loadTabs(scope), scope)
      ).tabs.find((tab) => tab.forkedFrom?.chatId === 'cursor-source');
      expect(fork).toBeTruthy();
      panel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${fork.id}"]`,
      );
      await expect(
        panel.getByText('Context code: ORCHID-62.', { exact: true }),
      ).toHaveCount(1);
      await send(
        panel,
        forkMode === 'ordinary'
          ? 'CURSOR_CHAT_E2E_TEXT'
          : `CURSOR_CHAT_E2E_CONTEXT_CHECK${forkMode.startsWith('max_') ? ` ${forkMode}` : ''}`,
        forkMode === 'ordinary'
          ? 'Cursor chat works.'
          : 'Context code: ORCHID-62.',
      );
      const profiles = cursorSessionsDir(userDataDir);
      if (['whole-chat', 'attachments'].includes(forkMode)) {
        const initialForkPrompt = readdirSync(profiles)
          .map((entry) =>
            readFileSync(
              path.join(profiles, entry, 'fixture-prompt.txt'),
              'utf8',
            ),
          )
          .find((prompt) => prompt.endsWith('CURSOR_CHAT_E2E_CONTEXT_CHECK'));
        expect(initialForkPrompt).toContain('/tmp/cursor-fork-attachment.pdf');
      }
      await send(
        panel,
        'CURSOR_CHAT_E2E_CONTEXT_SET: AZURE-17',
        'Context code: AZURE-17.',
      );
      const followUp = readdirSync(profiles)
        .map((entry) =>
          readFileSync(
            path.join(profiles, entry, 'fixture-prompt.txt'),
            'utf8',
          ),
        )
        .find((prompt) =>
          prompt.endsWith('CURSOR_CHAT_E2E_CONTEXT_SET: AZURE-17'),
        );
      expect(followUp).not.toContain('<forked_conversation>');
      const codes = readdirSync(profiles)
        .map((entry) =>
          readFileSync(
            path.join(profiles, entry, 'fixture-fork-context.txt'),
            'utf8',
          ),
        )
        .sort();
      expect(codes).toEqual(['AZURE-17', 'ORCHID-62']);
      await closeCanopy(launched.electronApp, launched.userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir, env: managed.env });
      window = await launched.electronApp.firstWindow();
      driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openMainPage();
      await driver.selectWorktree('demo-main');
      panel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${fork.id}"]`,
      );
      // Count replies only after the restored transcript has hydrated; an
      // existing reply must not satisfy the assertion for the next turn.
      await expect(
        panel.getByText('Context code: AZURE-17.', { exact: true }),
      ).toHaveCount(1);
      await send(
        panel,
        'CURSOR_CHAT_E2E_CONTEXT_CHECK',
        'Context code: AZURE-17.',
      );
      const resumedPrompt = readdirSync(profiles)
        .map((entry) =>
          readFileSync(
            path.join(profiles, entry, 'fixture-prompt.txt'),
            'utf8',
          ),
        )
        .find((prompt) => prompt.endsWith('CURSOR_CHAT_E2E_CONTEXT_CHECK'));
      expect(resumedPrompt).not.toContain('ORCHID-62');
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

// Deterministic stand-in for the bundled RTK binary. `rtk rewrite <command>`
// prints the command RTK would run instead; the host forwards that as the
// approval hook's `updated_input`, which the fixture applies like the CLI.
function writeRtkFixture(userDataDir) {
  const rtkPath = path.join(userDataDir, 'rtk-fixture');
  writeFileSync(
    rtkPath,
    '#!/bin/sh\n[ "$1" = rewrite ] || exit 2\nprintf \'rtk-fixture %s\' "$2"\n',
    { mode: 0o755 },
  );
  return rtkPath;
}
const SHELL_PROMPT =
  'CURSOR_CHAT_E2E_SHELL: Use only native Shell to create cursor-chat-result.txt with exactly CURSOR_CHAT_OK (no trailing newline). Use exactly: printf CURSOR_CHAT_OK > cursor-chat-result.txt. Do not retry if denied.';
const fixture =
  process.env.CURSOR_CHAT_LIVE_BINARY ??
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/cursor-acp-agent.mjs',
  );

// Live runs use the same verified private runtime as normal chat. The supplied
// executable must belong to the official pinned archive, not a diagnostic CLI.
function seedLiveCursorRuntime(userDataDir) {
  if (!live) return;
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const version = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )['cursor-cli'].version;
  const root = path.join(userDataDir, 'cursor-runtime');
  mkdirSync(root, { recursive: true });
  cpSync(path.dirname(fixture), path.join(root, version), { recursive: true });
}

test('Cursor rollout removes connected picker and settings on a live flag change', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-flag-e2e-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('chat-model-picker').click();
    await expect(
      window.getByTestId('chat-model-option-cursor-default'),
    ).toBeVisible();
    await launched.electronApp.evaluate(() => {
      const values = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
      values['canopy-desktop-cursor-harness'] = false;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(
      window.getByRole('group', { name: 'Cursor', exact: true }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(window.getByTestId('cursor-connection')).toHaveCount(0);
    await expect(window.getByTestId('cursor-approval-check')).toHaveCount(0);
    await driver.openSettingsSection('chat');
    await expect(window.getByTestId('settings-tab-chat')).not.toContainText(
      'Cursor',
    );
    // Turning rollout off is read-only for the user's managed connection.
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).cursorEnabled,
    ).toBe(true);
    await launched.electronApp.evaluate(() => {
      const values = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
      values['canopy-desktop-cursor-harness'] = true;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await driver.openSettingsSection('experiments');
    await expectCursorConnected(window);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

// Home has no chat identity until Send creates one. Exercise the picker and
// first turn through the managed runtime, with no pre-seeded Cursor chat.
for (const destination of ['new-worktree', 'existing-worktree']) {
  test(`Cursor from New Task: ${destination} starts with the selected harness`, async () => {
    test.skip(live, 'Deterministic managed-runtime regression');
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-home-e2e-'));
    const seeded = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: destination === 'existing-worktree',
    });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { lastChatBillingFramework: 'ai-credits' },
      }),
    );
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await window.evaluate(async () => {
        await window.api.saveCanopyCloudApiKey({
          apiKey: 'csk_cursor_home_billing_e2e',
        });
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      });

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toHaveAttribute(
        'data-workspace-selected',
        'true',
      );
      await home.getByTestId('chat-model-picker').click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      await driver.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      if (destination === 'existing-worktree') {
        await home.getByTestId('home-branch-picker-button').click();
        await window
          .getByTestId('home-branch-picker-worktree-demo-main')
          .click();
      }
      await home.getByTestId('home-composer-plus-button').click();
      await expect(window.getByTestId('home-plugins-button')).toBeVisible();
      await expect(window.getByTestId('home-commands-button')).toHaveCount(0);
      await window.keyboard.press('Escape');
      await home.getByTestId('chat-model-picker').click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toBeVisible();
      const cursorGroup = window.getByRole('group', {
        name: 'Cursor',
        exact: true,
      });
      await expect(cursorGroup).toBeVisible();
      // Third-party models retain their maker's section.
      await expect(cursorGroup.getByRole('menuitemradio')).toHaveCount(1);
      await expect(
        cursorGroup.getByTestId('chat-model-option-label-cursor-default'),
      ).toHaveText('Default');
      await expect(
        cursorGroup
          .getByTestId('chat-model-group-icon-provider:cursor')
          .locator('svg'),
      ).toBeVisible();
      const experimental = cursorGroup.getByRole('menuitem', {
        name: 'Cursor experimental features',
      });
      await experimental.hover();
      await expect(window.getByRole('tooltip')).toContainText(
        'Experimental Cursor integration for Code chats, Cowork, Orchestrator, and workflows. Chats support plugin MCP servers, skills, and commands. Enable managed subagents for Code worktree chats in desktop Settings > Labs.',
      );
      await window.mouse.move(0, 0);
      // Enter the list at the Cursor section's last row, then let menu
      // navigation walk up through the Cursor rows to the help. It must get
      // there without leaving the Cursor section.
      await cursorGroup.locator('[role="menuitemradio"]').last().focus();
      const cursorItems = await cursorGroup
        .locator('[role^="menuitem"]')
        .count();
      for (
        let step = 0;
        step < cursorItems &&
        !(await experimental.evaluate(
          (node) => node === document.activeElement,
        ));
        step++
      ) {
        const inCursorSection = await cursorGroup.evaluate((group) =>
          group.contains(document.activeElement),
        );
        expect(inCursorSection).toBe(true);
        await window.keyboard.press('ArrowUp');
      }
      await expect(experimental).toBeFocused();
      await expect(window.getByRole('tooltip')).toContainText(
        'Experimental Cursor integration',
      );
      const originalSelection = await home
        .getByTestId('chat-model-picker')
        .textContent();
      if (destination === 'new-worktree') await experimental.click();
      else await window.keyboard.press('Enter');
      await expect(window.getByTestId('chat-model-menu')).toBeVisible();
      await expect(window.getByRole('tooltip')).toContainText(
        'Experimental Cursor integration',
      );
      await expect(home.getByTestId('chat-model-picker')).toHaveText(
        originalSelection,
      );
      await expect(experimental).toBeFocused();
      await window.keyboard.press('Space');
      await expect(window.getByTestId('chat-model-menu')).toBeVisible();
      await selectModelOption(window, 'cursor-default');
      await expect(home.getByTestId('chat-model-picker')).toContainText(
        'Cursor',
      );
      await expect(home.getByTestId('home-thinking-level-button')).toHaveCount(
        0,
      );
      await home.getByTestId('home-composer-plus-button').click();
      await expect(window.getByTestId('home-schedule-button')).toBeDisabled();
      // Plugins stay available so their MCP servers reach Cursor; commands
      // need slash discovery, which Cursor does not have.
      await expect(window.getByTestId('home-plugins-button')).toBeVisible();
      await expect(window.getByTestId('home-commands-button')).toHaveCount(0);
      await window.keyboard.press('Escape');
      await home.getByTestId('home-composer-editor').fill('/');
      await expect(window.getByTestId('slash-command-menu')).toHaveCount(0);
      await home.getByTestId('home-composer-editor').fill('');
      if (destination === 'new-worktree') {
        // Chats is not a pickable project: clearing the project is how a
        // draft targets the catch-all. The catch-all is a Cowork workspace,
        // which runs Cursor too (2026-09-25), so the selection survives.
        await home.getByTestId('home-workspace-clear').click();
        await expect(home.getByTestId('chat-model-picker')).toContainText(
          'Cursor',
        );
        await home.getByTestId('chat-model-picker').click();
        await expect(
          window.getByTestId('chat-model-option-cursor-default'),
        ).toHaveCount(1);
        await window.keyboard.press('Escape');
        await home.getByTestId('home-workspace-select').click();
        await window
          .getByTestId('home-workspace-option-demo-ts-pnpm-vite')
          .click();
        await home.getByTestId('chat-model-picker').click();
        await selectModelOption(window, 'cursor-default');
      }
      await home
        .getByTestId('home-composer-editor')
        .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      const panel = window
        .getByTestId('panel-content-chat')
        .filter({ hasText: 'CURSOR_CHAT_E2E_TEXT:' });
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        'Cursor',
      );
      await expect(
        panel.getByText('Cursor chat works.', { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      expect(managed.state.requests).toBe(1);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

for (const stopDuringAuth of [false, true]) {
  test(`Cursor resumes after restart: ${stopDuringAuth ? 'Stop during authentication' : 'continues conversation'}`, async ({}, testInfo) => {
    test.skip(live && stopDuringAuth, 'Deterministic delayed authentication');
    if (live) test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-chat-e2e-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      tabs: [
        {
          id: 'cursor-chat',
          title: 'Cursor chat',
          model: 'sonnet',
          aiCreditsRouting: {
            active: true,
            scope: 'persistent',
            activatedAt: Date.now(),
          },
          planMode: true,
        },
      ],
    });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: { localMemoryEnabled: true } }),
    );
    mkdirSync(path.join(userDataDir, 'memory'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'memory/MEMORY.md'),
      'UNAVAILABLE_MEMORY_MARKER: remember this locally.',
    );
    seedLiveCursorRuntime(userDataDir);
    const managed = live ? undefined : await cursorRuntimeFixture();
    let launched = await launchCanopy({ userDataDir, env: managed?.env });
    const logs = [];
    launched.electronApp.on('console', (message) => logs.push(message.text()));
    launched.electronApp
      .process()
      .stderr?.on('data', (chunk) => logs.push(chunk.toString()));
    try {
      const window = await launched.electronApp.firstWindow();
      window.on('pageerror', (error) =>
        logs.push(error.stack ?? error.message),
      );
      window.on('console', (message) => {
        if (message.type() === 'error') logs.push(message.text());
      });
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      if (managed) expect(managed.state.requests).toBe(0);
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      if (managed) expect(managed.state.requests).toBe(1);
      await expect(
        window.evaluate(() => window.api.harnessAssignments.load()),
      ).resolves.toEqual(
        expect.objectContaining({ assignments: expect.any(Array) }),
      );
      await driver.closeSettings();
      await driver.openMainPage();
      await driver.selectWorktree('demo-main');
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await picker.click();
      await selectModelOption(window, 'cursor-default');
      await expect(picker).toContainText('Cursor');
      let panel = window.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-chat"]',
      );
      // Desktop Cursor chats review plan proposals, so the saved setting
      // reads as Plan, as it does for Claude and Codex.
      const planChip = panel.getByTestId('chat-input-plan-mode-inline-button');
      await expect(planChip).toHaveAttribute('aria-pressed', 'true');
      await expect(planChip).toContainText('Plan');
      await expect(planChip).not.toContainText('Read only');
      // The chip shows only while plan mode is on; removing it turns it off.
      await planChip.click();
      await expect(planChip).toHaveCount(0);
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          'CURSOR_CHAT_E2E_TEXT: Remember the code CANOPY_CURSOR_REMEMBERED for my next message. Reply exactly: Cursor chat works.',
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText('Cursor chat works.', { exact: true }),
      ).toBeVisible({ timeout: live ? 90_000 : 15_000 });
      // Streamed text can precede the terminal event that clears Stop.
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0, { timeout: 15_000 });
      await closeCanopy(launched.electronApp, launched.userDataDir, {
        keepUserData: true,
      });
      const profiles = cursorSessionsDir(userDataDir);
      const profile = path.join(profiles, readdirSync(profiles)[0]);
      if (!live) {
        // Local memory reaches Cursor through the app's MCP server, so the
        // prompt carries the same steering and injected context as Claude.
        const prompt = readFileSync(
          path.join(profile, 'fixture-prompt.txt'),
          'utf8',
        );
        expect(prompt).toMatch(/SaveMemory/);
        expect(prompt).toMatch(/SearchMemory/);
        expect(prompt).toMatch(/UNAVAILABLE_MEMORY_MARKER/);
      }
      if (stopDuringAuth)
        writeFileSync(path.join(profile, 'fixture-hold-auth'), '1');
      launched = await launchCanopy({ userDataDir, env: managed?.env });
      const restoredWindow = await launched.electronApp.firstWindow();
      const restoredDriver = new CanopyAppDriver(restoredWindow);
      await restoredDriver.waitForShell();
      if (!stopDuringAuth && !live) {
        await restoredDriver.openAuditPage();
        await restoredWindow
          .getByPlaceholder('Search the audit trail', { exact: true })
          .fill('cursor-default');
        await restoredWindow
          .locator('[data-testid^="audit-transcript-button-"]')
          .first()
          .click();
        await expect(
          restoredWindow.getByTestId('audit-transcript-modal'),
        ).toBeVisible();
        await expect(
          restoredWindow
            .getByTestId('audit-transcript-modal')
            .getByText('Cursor chat works.', { exact: true }),
        ).toBeVisible();
        await restoredWindow.getByTestId('audit-transcript-mode-raw').click();
        await expect(
          restoredWindow.getByTestId('audit-transcript-raw'),
        ).toContainText('canopy_assistant_patch');
        await expect(
          restoredWindow.getByTestId('audit-transcript-raw'),
        ).toContainText('"type":"result"');
        await restoredWindow.keyboard.press('Escape');
      }
      await restoredDriver.openMainPage();
      await restoredDriver.selectWorktree('demo-main');
      panel = restoredWindow.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-chat"]',
      );
      await expect(
        panel.getByText('Cursor chat works.', { exact: true }),
      ).toBeVisible();
      await panel
        .getByRole('textbox')
        .first()
        .fill(
          'CURSOR_CHAT_E2E_RESUME: Reply with only the exact code I asked you to remember earlier. Do not invent a code.',
        );
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      if (managed) expect(managed.state.requests).toBe(1);
      if (stopDuringAuth) {
        const pidFile = path.join(profile, 'fixture-auth-pid');
        await expect.poll(() => existsSync(pidFile)).toBe(true);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        await panel
          .getByRole('button', { name: 'Stop generation', exact: true })
          .click();
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
        await expect(
          panel.getByRole('button', { name: 'Stop generation', exact: true }),
        ).toHaveCount(0);
        await expect(panel.getByRole('textbox').first()).toBeEditable();
      } else {
        await expect(
          panel.getByText('CANOPY_CURSOR_REMEMBERED', { exact: true }),
        ).toBeVisible({ timeout: live ? 90_000 : 15_000 });
      }
    } finally {
      await testInfo.attach('diagnostics', {
        body: logs.join('\n'),
        contentType: 'text/plain',
      });
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed?.close();
    }
  });
}

for (const tool of live
  ? ['Write', 'Shell']
  : ['Write', 'Shell', 'Unicode Write', 'Large Write']) {
  const unicode = tool === 'Unicode Write';
  const large = tool === 'Large Write';
  const originalContent = large ? 'x'.repeat(256 * 1024) : '';
  const expectedContent = originalContent + 'CURSOR_CHAT_OK';
  const nativeTool = tool === 'Shell' ? 'Shell' : 'Write';
  const filename = unicode ? 'é-日本-result.txt' : 'cursor-chat-result.txt';
  for (const decision of unicode
    ? ['allow', 'deny']
    : live || large
      ? ['allow', 'deny', 'stop']
      : ['allow', 'deny', 'stop', 'deny-stop', 'quit']) {
    test(`Cursor chat ${tool}: ${decision} governs the actual file effect`, async ({}, testInfo) => {
      if (live) test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'cursor-chat-policy-'),
      );
      const seeded = seedDemoWorkspaces({
        userDataDir,
        apps: ['ts-pnpm-vite'],
      });
      seedWorktreeChat({
        userDataDir,
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        providerType: 'cursor',
        tabs: [
          {
            id: 'cursor-chat',
            title: 'Cursor chat',
            model: 'cursor-default',
            approvalMode: 'ask',
          },
        ],
      });
      seedLiveCursorRuntime(userDataDir);
      const managed = live ? undefined : await cursorRuntimeFixture();
      let launched = await launchCanopy({
        userDataDir,
        env: managed
          ? { ...managed.env, RTK_EXECUTABLE: writeRtkFixture(userDataDir) }
          : undefined,
      });
      try {
        const window = await launched.electronApp.firstWindow();
        const driver = new CanopyAppDriver(window);
        await driver.waitForShell();
        await driver.openSettings();
        await driver.openSettingsSection('experiments');
        await window.getByTestId('cursor-connect').click();
        await expectCursorConnected(window);
        await driver.closeSettings();
        await driver.openMainPage();
        await driver.selectWorktree('demo-main');
        const panel = window.locator(
          '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-chat"]',
        );
        const target = path.join(seeded.workspaces[0].worktreePath, filename);
        if (large) writeFileSync(target, originalContent);
        await panel
          .getByRole('textbox')
          .first()
          .fill(
            large
              ? `CURSOR_CHAT_E2E_WRITE_LARGE: Use native Write to append CURSOR_CHAT_OK to ${filename}, preserving its existing content. Do not retry if denied.`
              : `CURSOR_CHAT_E2E_${nativeTool.toUpperCase()}${unicode ? '_UNICODE' : ''}: Use only native ${nativeTool} to create ${filename} with exactly CURSOR_CHAT_OK (no trailing newline). ${tool === 'Shell' ? 'Use exactly: printf CURSOR_CHAT_OK > cursor-chat-result.txt.' : 'Use Write; do not use Shell.'} Do not retry if denied.`,
          );
        await panel
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        const card = panel.getByTestId('tool-approval-card');
        await expect(card).toBeVisible({ timeout: live ? 90_000 : 15_000 });
        // Native Write has a separate preparatory Read with the same tool ID.
        // An allow for that read must not grant the subsequent write.
        for (let reads = 0; reads < 6; reads += 1) {
          if (
            !(await card
              .getByText('Cursor wants to use Read', { exact: true })
              .isVisible())
          )
            break;
          await card.getByTestId('tool-approval-allow').click();
          await expect(
            card.getByText('Cursor wants to use Read', { exact: true }),
          ).toHaveCount(0);
          await expect(card).toBeVisible({ timeout: live ? 90_000 : 15_000 });
        }
        await expect(card).toContainText(`Cursor wants to use ${nativeTool}`);
        if (unicode) await expect(card).toContainText(filename);
        if (managed) {
          const profileRoot = cursorSessionsDir(userDataDir);
          const profile = readdirSync(profileRoot)[0];
          const encoded = seeded.workspaces[0].worktreePath
            .replace(/[^a-zA-Z0-9]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
          const config = JSON.parse(
            readFileSync(
              path.join(
                profileRoot,
                profile,
                'projects',
                encoded,
                '.cursor/hooks.json',
              ),
              'utf8',
            ),
          );
          const runtimeRoot = path.join(userDataDir, 'cursor-runtime');
          const version = readdirSync(runtimeRoot).find(
            (name) => !name.startsWith('.'),
          );
          // Release fuses disable Electron's Node mode. Approvals must launch
          // the integrity-checked Node shipped beside the managed CLI.
          expect(config.hooks.preToolUse[0].command).toContain(
            `'${path.join(runtimeRoot, version, 'node')}' `,
          );
        }
        expect(existsSync(target)).toBe(large);
        if (large) expect(readFileSync(target, 'utf8')).toBe(originalContent);
        if (tool === 'Shell' && !live)
          await expect(card).toContainText(
            'printf CURSOR_CHAT_OK > cursor-chat-result.txt',
          );
        if (decision === 'quit') {
          const appProcess = launched.electronApp.process();
          await launched.electronApp.evaluate(({ app }) => {
            app.quit();
          });
          await expect.poll(() => appProcess.exitCode !== null).toBe(true);
        } else if (decision === 'deny-stop') {
          await card.getByRole('button', { name: 'More deny options' }).click();
          // The deny menu renders in a portal outside the card.
          const denyMenu = card.page().getByTestId('tool-approval-deny-menu');
          await expect(denyMenu).toBeVisible();
          await denyMenu
            .getByRole('menuitem', { name: 'Deny and stop', exact: true })
            .click();
        } else if (decision === 'stop')
          await panel
            .getByRole('button', { name: 'Stop generation', exact: true })
            .click();
        else await card.getByTestId(`tool-approval-${decision}`).click();
        if (decision !== 'quit') {
          await expect(card).toHaveCount(0);
          await expect(
            panel.getByRole('button', { name: 'Stop generation', exact: true }),
          ).toHaveCount(0, { timeout: live ? 90_000 : 15_000 });
        }
        if (!live) {
          const root = cursorSessionsDir(userDataDir);
          const profile = readdirSync(root)[0];
          const pid = Number(
            readFileSync(path.join(root, profile, 'fixture-pid.txt'), 'utf8'),
          );
          await expect
            .poll(() => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            })
            .toBe(false);
        }
        expect(existsSync(target)).toBe(large || decision === 'allow');
        if (decision === 'allow')
          expect(readFileSync(target, 'utf8')).toBe(expectedContent);
        else if (large)
          expect(readFileSync(target, 'utf8')).toBe(originalContent);
        if (!live && ['allow', 'deny'].includes(decision)) {
          await expect(panel).not.toContainText(
            'without reaching the approval hook',
          );
          await expect(panel).toContainText(
            decision === 'allow' ? 'File created.' : 'File not created.',
          );
        }
        if (!live && tool === 'Shell') {
          // The card showed the proposed command; only an allowed command is
          // rewritten through RTK before the fixture records the effective
          // command that would run.
          const root = cursorSessionsDir(userDataDir);
          const profile = readdirSync(root)[0];
          const recorded = path.join(
            root,
            profile,
            'fixture-shell-command.txt',
          );
          if (decision === 'allow')
            expect(readFileSync(recorded, 'utf8')).toBe(
              'rtk-fixture printf CURSOR_CHAT_OK > cursor-chat-result.txt',
            );
          else expect(existsSync(recorded)).toBe(false);
        }
        if (decision !== 'quit')
          expect(
            await window.evaluate(() => window.api.approvals.pendingRequests()),
          ).toEqual([]);
        if (!live && tool === 'Shell' && ['allow', 'stop'].includes(decision)) {
          await driver.openAuditPage();
          await window
            .getByPlaceholder('Search the audit trail', { exact: true })
            .fill('cursor-default');
          const entry = window
            .getByTestId('audit-entry-list')
            .locator(':scope > div')
            .first();
          if (decision === 'allow') {
            await expect.soft(entry).toContainText('1 messages');
            await expect.soft(entry).toContainText('1 tool uses');
          } else {
            await expect(
              entry.getByText('Cancelled', { exact: true }),
            ).toBeVisible();
          }
        }
        if (decision === 'quit' && tool === 'Write' && !live) {
          await closeCanopy(launched.electronApp, userDataDir, {
            keepUserData: true,
          });
          const registry = JSON.parse(
            readFileSync(
              path.join(userDataDir, 'usage-limited-chats.json'),
              'utf8',
            ),
          );
          expect(registry.entries).toContainEqual(
            expect.objectContaining({
              chatId: 'cursor-chat',
              provider: 'cursor',
              resumeReason: 'app_shutdown',
            }),
          );
          launched = await launchCanopy({ userDataDir, env: managed.env });
          const restarted = await launched.electronApp.firstWindow();
          const restartedDriver = new CanopyAppDriver(restarted);
          await restartedDriver.waitForShell();
          await restarted.getByTestId('sidebar-create-task').click();
          const banner = restarted.getByTestId(
            'home-interrupted-sessions-banner',
          );
          await expect(banner).toBeVisible();
          await banner.getByTestId('home-interrupted-sessions-resume').click();
          const modal = restarted.getByTestId('usage-limit-resume-modal');
          await expect(modal).toContainText('Cursor chat');
          await expect(modal).toContainText('Application stopped');
          await restarted.getByTestId('usage-limit-resume-confirm').click();
          await expect(modal).toBeHidden();
          // One confirmed chat opens directly instead of the queue dialog.
          await expect(
            restarted.getByTestId('resume-queue-modal'),
          ).toBeHidden();
          await expect(
            restarted.locator('[data-panel-id="panel-chat-cursor-chat"]'),
          ).toBeVisible();
          const resumedCard = restarted.getByTestId('tool-approval-card');
          await expect(resumedCard).toBeVisible();
          if (
            await resumedCard
              .getByText('Cursor wants to use Read', { exact: true })
              .isVisible()
          ) {
            await resumedCard.getByTestId('tool-approval-allow').click();
            await expect(
              resumedCard.getByText('Cursor wants to use Read', {
                exact: true,
              }),
            ).toHaveCount(0);
          }
          await expect(resumedCard).toContainText('Cursor wants to use Write');
          const resumedTarget = path.join(
            seeded.workspaces[0].worktreePath,
            'result.txt',
          );
          // The card names the worktree-relative target and reveals the
          // absolute path on request (CAN-5165).
          const resumedTargetLabel = resumedCard.getByTestId(
            'tool-approval-file-target',
          );
          await expect(resumedTargetLabel).toHaveText('result.txt');
          await resumedTargetLabel.click();
          await expect(
            resumedCard.getByTestId('tool-approval-file-target-full'),
          ).toHaveText(resumedTarget);
          expect(existsSync(target)).toBe(false);
          expect(existsSync(resumedTarget)).toBe(false);
          await resumedCard.getByTestId('tool-approval-deny').click();
          await expect(resumedCard).toHaveCount(0);
          expect(existsSync(target)).toBe(false);
          expect(existsSync(resumedTarget)).toBe(false);
          const root = cursorSessionsDir(userDataDir);
          const profile = readdirSync(root)[0];
          expect(
            readFileSync(
              path.join(root, profile, 'fixture-loaded.txt'),
              'utf8',
            ),
          ).toBe('cursor-fixture-session');
        }
        await testInfo.attach('effect', {
          body: JSON.stringify({
            tool,
            decision,
            fileExists: existsSync(target),
          }),
          contentType: 'application/json',
        });
      } finally {
        await closeCanopy(launched.electronApp, launched.userDataDir);
        await managed?.close();
        cleanupDemoWorkspaces(seeded);
      }
    });
  }
}

test('Cursor provider error ends as failed and a later message can succeed', async () => {
  test.skip(
    live,
    'Replays a recorded provider failure without consuming account usage.',
  );
  const managed = await cursorRuntimeFixture();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-error-e2e-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      { id: 'cursor-error', title: 'Cursor error', model: 'cursor-default' },
    ],
  });
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    await window.evaluate(() => {
      globalThis.cursorTestResults = [];
      window.api.chat.onChatEvent((event) => {
        if (
          event.chatId === 'cursor-error' &&
          (event.data.type === 'result' || event.data.type === 'error')
        )
          globalThis.cursorTestResults.push(event.data);
      });
    });
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-error"]',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_PROVIDER_ERROR: Reply to this request.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect
      .poll(() => window.evaluate(() => globalThis.cursorTestResults.length))
      .toBe(1);
    expect(
      await window.evaluate(() => globalThis.cursorTestResults[0]),
    ).toMatchObject({
      type: 'error',
      error: expect.stringContaining('resource_exhausted'),
    });
    await expect(panel.getByText(/resource_exhausted/).first()).toBeVisible();
    await expect(
      panel
        .getByText('Cursor could not complete the request', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    await driver.openAuditPage();
    await window
      .getByPlaceholder('Search the audit trail', { exact: true })
      .fill('cursor-default');
    await window
      .locator('[data-testid^="audit-transcript-button-"]')
      .first()
      .click();
    await expect(window.getByTestId('audit-transcript-modal')).toContainText(
      'Cursor could not complete the request',
    );
    await window.keyboard.press('Escape');
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Try again.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => globalThis.cursorTestResults.length))
      .toBe(2);
    expect(
      await window.evaluate(() => globalThis.cursorTestResults[1]),
    ).toMatchObject({ is_error: false });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor data policy refusal names the model policy and ends as failed', async () => {
  test.skip(
    live,
    'Replays a recorded account refusal without consuming account usage.',
  );
  // The fixture replays the pinned CLI's settings notice; the mock backend's
  // model listing says why: the account has not accepted this model's data
  // retention policy.
  const key = 'cursor-data-policy-refusal';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    authUsage: {
      cursor: {
        account: {
          userId: 'policy-account',
          email: 'cursor-policy@example.com',
        },
        availableModels: {
          models: [
            {
              name: 'gemini-3.1-pro',
              clientDisplayName: 'Gemini 3.1 Pro',
              requiresDataRetention: true,
              reasonForZdrConsentBlock: 'individual_settings_blocked',
            },
          ],
        },
      },
    },
  });
  const policyCopy =
    'To use Gemini 3.1 Pro, accept its data retention policy in your Cursor dashboard, then try again, or choose another model.';
  const managed = await cursorRuntimeFixture();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-policy-e2e-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-policy',
        title: 'Cursor data policy',
        model: 'cursor:' + encodeURIComponent('gemini-3.1-pro[]'),
      },
    ],
  });
  const launched = await launchCanopy({
    userDataDir,
    env: { ...managed.env, CANOPY_MOCK_API_KEY: key },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    await window.evaluate(() => {
      globalThis.cursorTestResults = [];
      window.api.chat.onChatEvent((event) => {
        if (
          event.chatId === 'cursor-policy' &&
          (event.data.type === 'result' || event.data.type === 'error')
        )
          globalThis.cursorTestResults.push(event.data);
      });
    });
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-policy"]',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_SETTINGS_REQUIRED: Reply to this request.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect
      .poll(() => window.evaluate(() => globalThis.cursorTestResults.length))
      .toBe(1);
    expect(
      await window.evaluate(() => globalThis.cursorTestResults[0]),
    ).toMatchObject({ type: 'error', error: policyCopy });
    await expect(
      panel.getByText(policyCopy, { exact: false }).first(),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

test('Cursor chat Shell: the RTK preference off leaves the approved command unchanged', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-chat-rtk-off-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-chat',
        title: 'Cursor chat',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  // The same Settings > Chat preference that governs Claude's RTK hook.
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { rtkEnabled: false } }),
  );
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: { ...managed.env, RTK_EXECUTABLE: writeRtkFixture(userDataDir) },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-chat"]',
    );
    await panel.getByRole('textbox').first().fill(SHELL_PROMPT);
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toContainText('Cursor wants to use Shell', {
      timeout: 15_000,
    });
    await expect(card).toContainText(
      'printf CURSOR_CHAT_OK > cursor-chat-result.txt',
    );
    await card.getByTestId('tool-approval-allow').click();
    await expect(card).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(panel).not.toContainText('without reaching the approval hook');
    await expect(panel).toContainText('File created.');
    const target = path.join(
      seeded.workspaces[0].worktreePath,
      'cursor-chat-result.txt',
    );
    expect(readFileSync(target, 'utf8')).toBe('CURSOR_CHAT_OK');
    const root = cursorSessionsDir(userDataDir);
    const profile = readdirSync(root)[0];
    expect(
      readFileSync(
        path.join(root, profile, 'fixture-shell-command.txt'),
        'utf8',
      ),
    ).toBe('printf CURSOR_CHAT_OK > cursor-chat-result.txt');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

// Cowork chats offer Cursor since 2026-09-25
// (docs/planning/2026-09-25-cursor-cowork/); App Advisor since 2026-09-24
// (`app-advisor-cursor.spec.mjs`).
test('Cursor is offered in Cowork chats once the runtime is connected', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-surface-'));
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: managed.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCursor(window, app);
    await app.openChatPage();
    await window.getByTestId('sidebar-work-entry-seeded-cowork-chat').click();
    await window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first()
      .click();
    await expect(
      window.getByTestId('chat-model-option-cursor-default'),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
  }
});

test('App Advisor operates Cursor setup and the developer diagnostic through their panels', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-advisor-settings-'),
  );
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  const request = async (payload) =>
    electronApp.evaluate(
      async ({ BrowserWindow, ipcMain }, payload) => {
        const owner = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('surface=app-advisor'),
        );
        if (!owner) throw new Error('Main window missing');
        ipcMain.removeHandler('app-advisor:tool-response');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Advisor request timed out')),
            5000,
          );
          ipcMain.handle('app-advisor:tool-response', (_event, response) => {
            if (response.requestId !== payload.requestId) return;
            clearTimeout(timer);
            resolve(response);
          });
          owner.webContents.send('app-advisor:tool-request', payload);
        });
      },
      { ...payload, requestId: `cursor-advisor-${Date.now()}` },
    );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const connected = await request({
      kind: 'dispatch_action',
      action: { type: 'cursor.connection', operation: 'connect' },
    });
    expect(connected).toMatchObject({ ok: true });
    await expectCursorConnected(window);
    const state = await request({ kind: 'get_current_ui_state' });
    expect(state.uiState.snapshot.settings.cursor).toMatchObject({
      enabled: true,
      installed: true,
      busy: false,
    });
    await request({
      kind: 'dispatch_action',
      action: { type: 'cursor.connection', operation: 'disconnect' },
    });
    await expect(window.getByTestId('cursor-connection-status')).toHaveText(
      'Ready to connect',
    );
    await window.getByLabel('Cursor executable').fill(fixture);
    await request({
      kind: 'dispatch_action',
      action: { type: 'cursor.approval_check', operation: 'run' },
    });
    await expect(
      window
        .getByTestId('cursor-approval-check')
        .getByText('Waiting for your decision.', { exact: true }),
    ).toBeVisible();
    const checkState = await request({ kind: 'get_current_ui_state' });
    expect(
      checkState.uiState.snapshot.settings.cursorApprovalCheck,
    ).toMatchObject({ running: true, awaitingApproval: true });
    expect(JSON.stringify(checkState.uiState.snapshot.settings)).not.toContain(
      fixture,
    );
    await request({
      kind: 'dispatch_action',
      action: { type: 'cursor.approval_check', operation: 'stop' },
    });
    await expect(window.getByTestId('cursor-approval-check')).toContainText(
      'Stopped. No file created.',
    );
    const created = await request({
      kind: 'dispatch_action',
      action: { type: 'pipeline-assistant-chat.create_tab' },
    });
    expect(created.ok).toBe(true);
    await app.closeSettings();
    // create_tab already opened Workflows › Library with the assistant drawer.
    // Clicking the current Workflows row again would return the section to
    // its root and close the drawer (#6126), so only check the page.
    await app.expectPipelinesPage();
    await expect(window.getByTestId('pipeline-chat-panel')).toBeVisible();
    // The default narrow drawer intentionally hides the model picker. Resize
    // through its user control before asserting the rejected model selection.
    const separator = window.getByRole('separator', {
      name: 'Resize workflow assistant',
    });
    const separatorBox = await separator.boundingBox();
    const pageBox = await window
      .getByTestId('page-pipelines-root')
      .boundingBox();
    expect(separatorBox).not.toBeNull();
    expect(pageBox).not.toBeNull();
    await window.mouse.move(
      separatorBox.x + separatorBox.width / 2,
      separatorBox.y + separatorBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      pageBox.x + pageBox.width * 0.45,
      separatorBox.y + separatorBox.height / 2,
    );
    await window.mouse.up();
    await expect(
      window
        .getByTestId('pipeline-chat-panel')
        .getByTestId('chat-model-picker'),
    ).toBeVisible();
    const selected = await request({
      kind: 'dispatch_action',
      action: {
        type: 'pipeline-assistant-chat.set_model',
        model: 'cursor-default',
      },
    });
    expect(selected.ok).toBe(false);
    await expect(window.getByTestId('pipeline-chat-panel')).not.toContainText(
      'Cursor',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
  }
});

test('Cursor keeps unsafe scheduling unavailable and a restored draft clearable', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-schedule-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const runAt = new Date(Date.now() + 3600000).toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-scheduled',
        title: 'Cursor scheduled draft',
        model: 'cursor-default',
        scheduledSendDraft: { runAt },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const chip = panel.getByTestId('chat-input-scheduled-send-chip');
    await expect(chip).toBeVisible();
    await expect(
      panel.getByTestId('chat-input-scheduled-send-pill'),
    ).toBeDisabled();
    await panel.getByTestId('chat-input-plus-button').click();
    await expect(window.getByTestId('chat-input-schedule-button')).toHaveCount(
      0,
    );
    await window.keyboard.press('Escape');
    await panel.getByTestId('chat-input-scheduled-send-clear').click();
    await expect(chip).toHaveCount(0);
    const activities = existsSync(path.join(userDataDir, 'automations.json'))
      ? JSON.parse(
          readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
        ).activities
      : [];
    expect(activities).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor recovers a committed proposal missed before hydration without duplicating its plan on reload', async () => {
  test.skip(live, 'Deterministic persisted proposal');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-proposal-recovery-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-recovery',
        title: 'Cursor proposal recovery',
        attentionDismissedAt: 123,
        pendingSystemInstructions: [
          { id: 'saved-imported-context', text: 'Keep imported requirements.' },
        ],
        model: 'cursor-default',
        executionHarness: 'cursor',
        planMode: true,
        pendingPlanExitRequestId: 'missed-cursor-request',
        pendingPlanExit: {
          source: 'cursor',
          reviewMode: 'proposal',
          plan: '# Recover this committed proposal',
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const plans = () =>
      window.evaluate(() =>
        window.api.activity.plans.list({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      );
    await expect.poll(async () => (await plans()).length).toBe(1);
    const [first] = await plans();
    expect(first).toMatchObject({ source: 'cursor', latestRevisionNumber: 1 });
    expect(first.revisions[0]).toMatchObject({
      proposalRequestId: 'missed-cursor-request',
    });
    await expect(window.getByTestId('chat-plan-approval')).toBeVisible();
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('chat-plan-approval')).toBeVisible();
    expect(
      (await plans()).map((plan) => [plan.id, plan.latestRevisionNumber]),
    ).toEqual([[first.id, 1]]);
    await window.evaluate(() =>
      window.api.chat.command({
        schemaVersion: 1,
        commandId: 'missed-cursor-revision',
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'cursor-recovery',
          patch: {
            trackedPlanId: null,
            pendingPlanExitRequestId: 'missed-cursor-revision',
            pendingPlanExit: {
              source: 'cursor',
              reviewMode: 'proposal',
              plan: '# Revised committed proposal',
            },
          },
        },
      }),
    );
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect
      .poll(async () => (await plans())[0]?.latestRevisionNumber)
      .toBe(2);
    const [revised] = await plans();
    expect(revised.id).toBe(first.id);
    expect(revised.revisions[1]).toMatchObject({
      proposalRequestId: 'missed-cursor-revision',
      content: '# Revised committed proposal',
    });
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('chat-plan-approval')).toBeVisible();
    expect(
      (await plans()).map((plan) => [plan.id, plan.latestRevisionNumber]),
    ).toEqual([[first.id, 2]]);
    const restored = await window.evaluate(() =>
      window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(
      restored.tabsFile.tabs.find((tab) => tab.id === 'cursor-recovery')
        ?.pendingSystemInstructions,
    ).toEqual(
      expect.arrayContaining([
        { id: 'saved-imported-context', text: 'Keep imported requirements.' },
      ]),
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor plan mode keeps its proposal pending while implementation admission is unavailable', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-proposal-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-plan',
        title: 'Cursor plan',
        model: 'cursor-default',
        executionHarness: 'cursor',
        planMode: true,
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const { electronApp } = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const composer = panel.locator('[data-chat-composer-root]').first();
    await expect(
      composer.getByTestId('chat-input-plan-mode-inline-button'),
    ).toContainText('Plan');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_PROPOSED_PLAN');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    const prompt = composer.getByTestId('chat-plan-approval');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(prompt).toContainText('Implement this plan?');
    await expect(prompt.getByTestId('chat-plan-pipeline')).toHaveCount(0);
    await expect
      .poll(async () =>
        (
          await window.evaluate(() =>
            window.api.activity.plans.list({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            }),
          )
        ).map((plan) => [plan.source, plan.reviewStatus]),
      )
      .toEqual([['cursor', 'pending']]);

    await expect(prompt.getByTestId('chat-plan-implement')).toBeDisabled();
    await expect(prompt.getByTestId('chat-plan-implement')).toContainText(
      'Implementation unavailable',
    );
    await prompt.getByTestId('chat-plan-explore').click();
    const execute = window.getByTestId('plan-panel-execute');
    await expect(execute).toBeVisible();
    await execute.click();
    await expect(
      window.getByTestId('plan-panel-execute-implement'),
    ).toBeDisabled();
    await expect(
      window.getByTestId('plan-panel-execute-pipeline'),
    ).toBeDisabled();
    // Copy plan sits beside Share, outside the Execute menu (CAN-5354).
    await expect(window.getByTestId('plan-panel-execute-copy')).toHaveCount(0);
    await execute.click();
    await expect(window.getByTestId('plan-panel-copy')).toBeEnabled();
    await expect(window.getByTestId('plan-panel-copy')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByTestId('chat-plan-implement')).toBeDisabled();
    await expect(
      panel.getByText('Approved. Implement the plan.', { exact: true }),
    ).toHaveCount(0);
    // While the proposal waits, the composer swaps the Plan chip for Plan
    // ready (icon only when compact), and the open card hides both. Closing
    // it keeps the proposal pending and plan mode on.
    await prompt.getByTestId('chat-plan-approval-close').click();
    await expect(prompt).toHaveCount(0);
    const ready = composer.getByTestId('chat-input-plan-ready-chip');
    await expect(ready).toBeVisible();
    await expect(ready).toHaveAccessibleName('Plan ready, review it');
    const restored = await window.evaluate(() =>
      window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(
      restored.tabsFile.tabs.find((tab) => tab.id === 'cursor-plan')?.planMode,
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

for (const damage of ['missing', 'non-executable']) {
  test(`Cursor reconnect repairs a ${damage} managed runtime after restart`, async () => {
    const managed = await cursorRuntimeFixture();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-missing-runtime-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    let launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      let window = await launched.electronApp.firstWindow();
      let driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      await launched.electronApp.close();
      const runtimeRoot = path.join(userDataDir, 'cursor-runtime');
      if (damage === 'missing') {
        rmSync(runtimeRoot, { recursive: true, force: true });
      } else {
        const version = readdirSync(runtimeRoot).find(
          (name) => !name.startsWith('.'),
        );
        expect(version).toBeTruthy();
        chmodSync(path.join(runtimeRoot, version, 'cursor-agent'), 0o600);
      }
      launched = await launchCanopy({ userDataDir, env: managed.env });
      window = await launched.electronApp.firstWindow();
      driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await driver.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      await window
        .getByTestId('page-home')
        .getByTestId('chat-model-picker')
        .click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      expect(managed.state.requests).toBe(1);
      await expect(window.getByTestId('cursor-connect')).toHaveText(
        'Connect Cursor',
      );
      await expect(window.getByTestId('cursor-connection-account')).toHaveCount(
        0,
      );
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      expect(managed.state.requests).toBe(2);
      await driver.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      await window
        .getByTestId('page-home')
        .getByTestId('chat-model-picker')
        .click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toBeVisible();
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

test('a scheduled draft does not offer a dead edit action in terminal mode', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-review-terminal-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: 'scheduled',
        title: 'Scheduled draft',
        model: 'opus[1m]',
        scheduledSendDraft: {
          runAt: new Date(Date.now() + 3600000).toISOString(),
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    const pill = panel.getByTestId('chat-input-scheduled-send-pill');
    await expect(pill).toBeEnabled();
    await panel.getByRole('textbox').first().fill('!pwd');
    await expect(pill).toBeHidden();
    await panel.getByRole('textbox').first().fill('Explain this project');
    await expect(pill).toBeEnabled();
    await pill.click();
    await expect(window.getByTestId('schedule-message-modal')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor accepts a restored inactive AI Credits routing record', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-inactive-billing-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'inactive',
        title: 'Cursor inactive billing',
        model: 'cursor-default',
        aiCreditsRouting: {
          active: false,
          scope: 'persistent',
          activatedAt: Date.now(),
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-inactive"]',
    );
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Cursor',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

// Round-eight boundary regressions use existing user-visible entry points.
// Scheduled sends stay unavailable for Cursor until the scheduler can bind
// inherited settings through admission (CAN-4325), so an existing-chat
// automation is refused before dispatch whether or not Cursor is connected.
for (const connected of [false, true]) {
  test(`Cursor existing-chat automation is refused before dispatch when Cursor is ${connected ? 'connected' : 'not connected'}`, async () => {
    test.skip(live, 'Deterministic managed runtime');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-automation-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'cursor',
      tabs: [
        {
          id: 'cursor-automation',
          title: 'Cursor automation target',
          model: 'cursor-default',
          executionHarness: 'cursor',
          approvalMode: 'full-access',
        },
      ],
    });
    const now = new Date().toISOString();
    writeFileSync(
      path.join(userDataDir, 'automations.json'),
      JSON.stringify({
        version: 1,
        updatedAt: now,
        activities: [
          {
            version: 1,
            id: 'cursor-existing',
            name: 'Continue Cursor chat',
            enabled: true,
            schedule: {
              kind: 'one_time',
              runAt: '2099-01-01T00:00:00.000Z',
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              chatId: 'cursor-automation',
              prompt:
                'CURSOR_CHAT_E2E_PROVIDER_ERROR: Automated prompt must not be sent',
            },
            createdAt: now,
            updatedAt: now,
            failureCount: 0,
          },
        ],
        recentRuns: [],
      }),
    );
    // The fixture only makes a later Connect deterministic; it never enables
    // Cursor by itself, so the disconnected case simply never clicks Connect.
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (connected) {
        await app.openSettings();
        await app.openSettingsSection('experiments');
        await window.getByTestId('cursor-connect').click();
        await expectCursorConnected(window);
        await app.closeSettings();
      }
      await app.openAutomationsPage();
      await app
        .workflowsLibraryAutomationRow('cursor-existing')
        .getByTestId('workflows-library-run')
        .click();
      const latestRun = () =>
        JSON.parse(
          readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
        ).recentRuns[0];
      await expect
        .poll(() => latestRun()?.error)
        .toBe(
          'Scheduled messages are not available for Cursor chats. Choose another model.',
        );
      expect(latestRun()?.status).toBe('failure');
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const persisted = await window.evaluate(() =>
        window.api.chat.loadTabs({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      );
      expect(JSON.stringify(persisted)).not.toContain(
        'Automated prompt must not be sent',
      );
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

test('Cursor restored Pipeline Assistant rejects a prompt before persistence when Cursor is not connected', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-pipeline-'));
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'pipeline-editor',
    worktreeId: 'pipeline-editor',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-pipeline',
        title: 'Restored Cursor tab',
        model: 'cursor-default',
        executionHarness: 'cursor',
      },
    ],
  });
  mkdirSync(path.join(userDataDir, 'app-workspaces'), { recursive: true });
  renameSync(
    path.join(userDataDir, 'workspaces', 'pipeline-editor'),
    path.join(userDataDir, 'app-workspaces', 'pipeline-editor'),
  );
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Pipeline Assistant runs Cursor once it is connected, so the restored
    // Cursor tab is checked against the runtime and account before the prompt
    // or settings persist. Connect is never clicked here.
    // The restored tab has no messages, so the drawer starts closed.
    const panel = await openPipelineAssistant(app);
    await panel
      .getByRole('textbox')
      .first()
      .fill('Unsupported Cursor pipeline prompt');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel
        .getByText('Connect Cursor in Settings to use Workflow Assistant.', {
          exact: false,
        })
        .first(),
    ).toBeVisible();
    const persisted = await window.evaluate(() =>
      window.api.chat.loadTabs({
        projectId: 'pipeline-editor',
        worktreeId: 'pipeline-editor',
      }),
    );
    expect(JSON.stringify(persisted)).not.toContain(
      'Unsupported Cursor pipeline prompt',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
  }
});

test('Cursor disconnected chat never runs the developer diagnostic executable', async () => {
  test.skip(live, 'Deterministic runtime-boundary regression');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-disconnected-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-disconnected',
        title: 'Disconnected Cursor',
        model: 'cursor-default',
        executionHarness: 'cursor',
      },
    ],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { cursorEnabled: false, cursorAgentPath: fixture },
    }),
  );
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-disconnected"]',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Hello from a disconnected session.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Error: Connect Cursor in Settings to start chatting.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(existsSync(cursorSessionsDir(userDataDir))).toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});

test('a Cursor Cowork chat runs the fixture turn in the Cowork folder with Cowork steering', async () => {
  test.skip(live, 'Deterministic Cowork turn');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-cowork-'));
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  mkdirSync(path.join(userDataDir, 'workspaces', 'seeded-cowork', 'home'), {
    recursive: true,
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await connectCursor(window, driver);
    await driver.openChatPage();
    await window.getByTestId('sidebar-work-entry-seeded-cowork-chat').click();
    await window.locator('[data-testid^="panel-add-tab-"]').first().click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    expect(managed.state.requests).toBe(1);
    const profileDirs = coworkCursorSessionsDirs(userDataDir);
    expect(profileDirs).toHaveLength(1);
    const prompt = readdirSync(profileDirs[0])
      .map((entry) =>
        readFileSync(
          path.join(profileDirs[0], entry, 'fixture-prompt.txt'),
          'utf8',
        ),
      )
      .join('\n');
    expect(prompt).toContain('cowork project');
    expect(prompt).toContain('DispatchAction');
    expect(prompt).toContain('WatchGitHubItems');
    expect(prompt).toContain('GetGitHubPullRequestStatus');
    expect(prompt).toContain('gh pr checks --watch');
    expect(prompt).not.toMatch(/SetBaseBranch|GetGitPreferences/);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
  }
});

for (const surface of ['Home', 'worktree']) {
  test(`Cursor diagnostic path never exposes chat in ${surface}`, async () => {
    test.skip(live, 'Deterministic picker availability regression');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-picker-availability-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      tabs: [
        {
          id: 'availability-chat',
          title: 'Picker availability',
          model: 'claude-sonnet-4-6',
        },
      ],
    });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { cursorEnabled: false, cursorAgentPath: fixture },
      }),
    );
    const launched = await launchCanopy({ userDataDir });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      if (surface === 'Home') {
        await window.getByTestId('sidebar-create-task').click();
      } else {
        await driver.openMainPage();
        await driver.selectWorktree('demo-main');
      }
      const container =
        surface === 'Home'
          ? window.getByTestId('page-home')
          : window.locator(
              '[data-testid="panel-content-chat"][data-panel-id="panel-chat-availability-chat"]',
            );
      await container.getByTestId('chat-model-picker').click();
      await expect(window.getByRole('menu').last()).toBeVisible();
      // An existing provider row proves the picker loaded before asserting absence.
      await expect(window.getByRole('menuitemradio').first()).toBeVisible();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      expect(
        (await window.evaluate(() => window.api.loadPreferences()))
          .cursorEnabled,
      ).toBe(false);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      cleanupDemoWorkspaces(seeded);
    }
  });
}

test('Cursor stays selectable in a credits-only worktree chat', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-credit-picker-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [
      {
        id: 'credits-cursor',
        title: 'Cursor account billing',
        model: 'gpt-5.5',
      },
    ],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { lastChatBillingFramework: 'ai-credits' },
    }),
  );
  const authKey = 'cursor-credits-only-picker';
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: {
      ...managed.env,
      CANOPY_MOCK_API_KEY: authKey,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await connectMockCloudAccount(window, 'csk_cursor_credit_picker_e2e');
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    await launched.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        'model-registry:updated',
        {
          claude: [{ id: 'opus[1m]', label: 'Opus' }],
          codex: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
          ollama: [],
          agents: [],
          aliases: {},
          aiGatewayModels: [],
          gatewayRoutes: [
            {
              modelId: 'gpt-5.5',
              gatewayId: 'openai/gpt-5.5',
              family: 'openai',
              recommendedHarness: 'codex',
              gatewayOnly: false,
              contextWindow: 200000,
              supportsPromptCaching: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        },
      );
    });
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-credits-cursor"]',
    );
    await panel.getByTestId('chat-model-picker').click();
    // A credits-only chat's billing is locked: no row offers a billing menu.
    await expect(offeredBillingMenus(window)).toHaveCount(0);
    await expect(
      window.getByTestId('chat-model-option-cursor-default'),
    ).toBeVisible();
    await selectModelOption(window, 'cursor-default');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Cursor',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
  }
});

for (const route of ['canonical', 'advisor-action']) {
  test(`Cursor model mutation is accepted on a connected Cowork tab: ${route}`, async () => {
    test.skip(live, 'Deterministic model boundary');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-model-boundary-'),
    );
    seedCoworkWorkspace({ userDataDir, collapsed: false });
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectCursor(window, app);
      await app.openChatPage();
      await window.getByTestId('sidebar-work-entry-seeded-cowork-chat').click();
      await window.locator('[data-testid^="panel-add-tab-"]').first().click();
      await window.getByTestId('panel-add-menu-item-new-chat').click();
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await expect(picker).toBeVisible();
      await picker.click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toHaveCount(1);
      await window.keyboard.press('Escape');
      const target = await window.evaluate(async () => {
        const entry = await window.api.workEntries.resolveChat({
          projectId: 'seeded-cowork',
          chatId: 'seeded-cowork-chat',
        });
        const target = {
          projectId: 'seeded-cowork',
          worktreeId: entry.entryId ?? 'home',
        };
        const tabs = await window.api.chat.loadTabs(target);
        return { ...target, chatId: tabs.activeTabId };
      });
      const before = await window.evaluate(
        (target) => window.api.chat.loadTabs(target),
        target,
      );
      expect(target.chatId).not.toBe('seeded-cowork-chat');
      expect(before.tabs.find((t) => t.id === target.chatId)).toBeDefined();
      let accepted;
      if (route === 'canonical') {
        accepted = await window.evaluate(
          (target) =>
            window.api.chat.changeModel({ ...target, model: 'cursor-default' }),
          target,
        );
      } else {
        const response = await launched.electronApp.evaluate(
          async ({ BrowserWindow, ipcMain }, target) => {
            const owner = BrowserWindow.getAllWindows().find(
              (w) => !w.webContents.getURL().includes('surface=app-advisor'),
            );
            ipcMain.removeHandler('app-advisor:tool-response');
            return new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Advisor response timed out')),
                5000,
              );
              ipcMain.handle(
                'app-advisor:tool-response',
                (_event, response) => {
                  if (response.requestId !== 'cursor-model-boundary') return;
                  clearTimeout(timer);
                  resolve(response);
                },
              );
              owner.webContents.send('app-advisor:tool-request', {
                requestId: 'cursor-model-boundary',
                kind: 'dispatch_action',
                action: {
                  type: 'standalone-chat.set_model',
                  projectId: target.projectId,
                  chatId: target.chatId,
                  model: 'cursor-default',
                },
              });
            });
          },
          target,
        );
        accepted = response.ok;
      }
      expect(accepted).toBe(true);
      // The advisor route awaits the canonical model command (4c9fd93f00), so
      // the change has landed by now; the poll is slack against the tabs
      // broadcast, not a wait for the command itself.
      await expect
        .poll(
          async () => {
            const after = await window.evaluate(
              (target) => window.api.chat.loadTabs(target),
              target,
            );
            return after.tabs.find((t) => t.id === target.chatId)?.model;
          },
          { timeout: 15_000 },
        )
        .toBe('cursor-default');
      await picker.click();
      await expect(
        window.getByTestId('chat-model-option-cursor-default'),
      ).toHaveCount(1);
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
    }
  });
}

test('Home keeps a Cursor selection when switching to a Cowork workspace and runs the Work Entry on it', async () => {
  test.skip(live, 'Deterministic managed runtime');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-cowork-home-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  // `seedCoworkWorkspace` writes `workspaces/index.json` from scratch, which
  // would drop the demo workspace; merge the two indexes so Home lists both.
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const demoIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  const coworkIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeFileSync(
    indexPath,
    JSON.stringify({
      ...demoIndex,
      workspaces: [
        ...demoIndex.workspaces,
        ...coworkIndex.workspaces.map((workspace, offset) => ({
          ...workspace,
          order: demoIndex.workspaces.length + offset,
        })),
      ],
    }),
  );
  mkdirSync(path.join(userDataDir, 'workspaces', 'seeded-cowork', 'home'), {
    recursive: true,
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await connectCursor(window, driver);
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    // Pick Cursor with a Code workspace selected, then switch to Cowork: the
    // draft must keep the model instead of clearing it.
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId('home-workspace-option-demo-ts-pnpm-vite').click();
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await expect(home.getByTestId('chat-model-picker')).toContainText('Cursor');
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId('home-workspace-option-seeded-cowork').click();
    await expect(home.getByTestId('chat-model-picker')).toContainText('Cursor');
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    const panel = window
      .getByTestId('panel-content-chat')
      .filter({ hasText: 'CURSOR_CHAT_E2E_TEXT:' });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('a disconnected runtime refuses a Cowork Cursor send before persisting', async () => {
  test.skip(live, 'Deterministic Cowork preflight');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-cowork-offline-'),
  );
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openChatPage();
    await window.getByTestId('sidebar-work-entry-seeded-cowork-chat').click();
    const result = await window.evaluate(async () => {
      try {
        await window.api.chat.sendMessage({
          projectId: 'seeded-cowork',
          worktreeId: 'home',
          chatId: 'cursor-offline',
          userMessageId: 'cursor-offline-prompt',
          text: 'Offline Cursor Cowork prompt',
          model: 'cursor-default',
        });
        return 'accepted';
      } catch (error) {
        return String(error);
      }
    });
    expect(result).toContain('Connect Cursor in Settings');
    const saved = await window.evaluate(() =>
      window.api.chat.loadTabs({
        projectId: 'seeded-cowork',
        worktreeId: 'home',
      }),
    );
    expect(JSON.stringify(saved)).not.toContain('Offline Cursor Cowork prompt');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

// Also the live check for Cursor in Cowork: with CURSOR_CHAT_LIVE_BINARY the
// pinned CLI runs against the Cowork folder, which is not a git repository.
test('a Cowork Cursor Write in Ask mode prompts through the approval card and writes into the Cowork folder', async () => {
  if (live) test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-cowork-approval-'),
  );
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  seedLiveCursorRuntime(userDataDir);
  const coworkHome = path.join(
    userDataDir,
    'workspaces',
    'seeded-cowork',
    'home',
  );
  mkdirSync(coworkHome, { recursive: true });
  // This fixture supplies current approval defaults explicitly. Mark the
  // compatibility migration complete so launch does not upgrade an "older"
  // profile's defaults to Full Access and swallow the Ask card.
  writeFileSync(
    path.join(userDataDir, 'migrations.json'),
    JSON.stringify({ version: 1, approval_defaults_full_access: true }),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        approvalDefaults: { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' },
      },
    }),
  );
  const managed = live ? undefined : await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed ? managed.env : undefined,
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await connectCursor(window, driver);
    await driver.openChatPage();
    await window.getByTestId('sidebar-work-entry-seeded-cowork-chat').click();
    await window.locator('[data-testid^="panel-add-tab-"]').first().click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    // The fixture agent always writes this name into its session cwd.
    const filename = 'cursor-chat-result.txt';
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        `CURSOR_CHAT_E2E_WRITE: Use only native Write to create ${filename} with exactly CURSOR_CHAT_OK (no trailing newline). Use Write; do not use Shell. Do not retry if denied.`,
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: live ? 90_000 : 15_000 });
    for (let reads = 0; reads < 6; reads += 1) {
      if (
        !(await card
          .getByText('Cursor wants to use Read', { exact: true })
          .isVisible())
      )
        break;
      await card.getByTestId('tool-approval-allow').click();
      await expect(
        card.getByText('Cursor wants to use Read', { exact: true }),
      ).toHaveCount(0);
      await expect(card).toBeVisible({ timeout: live ? 90_000 : 15_000 });
    }
    await expect(
      card.getByText('Cursor wants to use Write', { exact: true }),
    ).toBeVisible();
    await card.getByTestId('tool-approval-allow').click();
    const target = path.join(coworkHome, filename);
    await expect
      .poll(() => (existsSync(target) ? readFileSync(target, 'utf8') : null), {
        timeout: live ? 90_000 : 15_000,
      })
      .toBe('CURSOR_CHAT_OK');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed?.close();
  }
});

test('Cursor model mutation is refused for a replayed Portal composer command', async () => {
  // The Portal adapter runs the managed-runtime preflight before it forwards
  // a set-model command; a replayed command that reaches the renderer after
  // the runtime went away is refused by the canonical `changeChatModel` IPC
  // (the renderer no longer special-cases Cursor), so the tab stays intact.
  test.skip(live, 'Deterministic Portal boundary');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-portal-model-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: true,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [
      {
        id: 'portal-cursor-boundary',
        title: 'Portal target',
        model: 'gpt-5.6-luna',
        messages: [],
      },
    ],
  });
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toBeVisible();
    const response = await launched.electronApp.evaluate(
      async ({ BrowserWindow, ipcMain }) => {
        const owner = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('surface=app-advisor'),
        );
        ipcMain.removeHandler('chat:portal-composer-command-result');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Portal response timed out')),
            5000,
          );
          ipcMain.handle(
            'chat:portal-composer-command-result',
            (_event, response) => {
              if (response.requestId !== 'cursor-portal-model') return;
              clearTimeout(timer);
              resolve(response);
            },
          );
          owner.webContents.send('chat:portal-composer-command', {
            requestId: 'cursor-portal-model',
            command: {
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              chatId: 'portal-cursor-boundary',
              kind: 'model',
              model: 'cursor-default',
            },
          });
        });
      },
    );
    expect(response).toMatchObject({
      ok: false,
      code: 'invalid_target',
      error: 'The composer change is not available for this chat.',
    });
    const saved = await window.evaluate(() =>
      window.api.chat.loadTabs({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(
      saved.tabs.find((t) => t.id === 'portal-cursor-boundary')?.model,
    ).toBe('gpt-5.6-luna');
    await picker.click();
    await expect(
      window.getByTestId('chat-model-option-cursor-default'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor worktree prompt does not advertise unavailable code-graph tools', async () => {
  test.skip(
    live,
    'Observes the deterministic child prompt without consuming account usage.',
  );
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-graph-prompt-e2e-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-graph-prompt',
        title: 'Cursor graph prompt',
        model: 'cursor-default',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('code-graph');
    await expect(window.getByTestId('code-graph-mode-enabled')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree('demo-main');
    // Build a real small graph through public IPC so the availability nudge
    // is eligible; do not mock the prompt builder or its feature gate.
    const graph = await window.evaluate(() =>
      window.api.codeGraphBuildWorktree({
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(graph).toMatchObject({ state: 'ready', enabled: true });
    expect(
      existsSync(
        path.join(
          userDataDir,
          'workspaces/demo-ts-pnpm-vite/worktree-data/demo-main/code-graph/graph.db',
        ),
      ),
    ).toBe(true);
    const panel = window.locator(
      '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cursor-graph-prompt"]',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Describe the source files.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
    const prompt = readFileSync(
      path.join(
        cursorSessionsDir(userDataDir),
        readdirSync(cursorSessionsDir(userDataDir))[0],
        'fixture-prompt.txt',
      ),
      'utf8',
    );
    expect(prompt).toContain(
      'CURSOR_CHAT_E2E_TEXT: Describe the source files.',
    );
    expect(prompt).not.toMatch(
      /GetCodeGraphContext|QueryCodeGraph|SearchCodeGraph|A code graph exists/,
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

for (const destination of ['new-worktree', 'existing-worktree']) {
  test(`Cursor stale Home selection preserves its draft after disconnect: ${destination}`, async () => {
    test.skip(live, 'Deterministic managed-runtime boundary');
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture();
    try {
      await f.connection(true);
      await f.window.getByTestId('sidebar-create-task').click();
      const home = f.window.getByTestId('page-home');
      if (destination === 'existing-worktree') {
        await home.getByTestId('home-branch-picker-button').click();
        await f.window
          .getByTestId('home-branch-picker-worktree-demo-main')
          .click();
      }
      await home.getByTestId('chat-model-picker').click();
      await selectModelOption(f.window, 'cursor-default');
      await home
        .getByTestId('home-composer-editor')
        .fill('Keep my Cursor draft after disconnect');
      await f.connection(false);
      await expect(home.getByTestId('chat-model-picker')).toContainText(
        'Cursor',
      );
      const before = await f.tab();
      await home.getByTestId('home-send-button').click();
      await expect(home).toBeVisible();
      await expect(home.getByText(/Connect Cursor/)).toBeVisible();
      await expect(home.getByTestId('home-composer-editor')).toHaveText(
        'Keep my Cursor draft after disconnect',
      );
      expect(await f.tab()).toEqual(before);
    } finally {
      await f.close();
    }
  });
}

test('Cursor unavailable model replay preserves the existing Code tab', async () => {
  test.skip(live, 'Deterministic managed-runtime boundary');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  try {
    await f.openChat();
    const picker = f.window
      .getByTestId('panel-content-chat')
      .getByTestId('chat-model-picker');
    await picker.click();
    await expect(
      f.window.getByTestId('chat-model-option-cursor-default'),
    ).toHaveCount(0);
    await f.window.keyboard.press('Escape');
    const before = await f.tab();
    const accepted = await f.window.evaluate(
      (target) =>
        window.api.chat.changeModel({ ...target, model: 'cursor-default' }),
      f.target,
    );
    expect(accepted).toBe(false);
    expect(await f.tab()).toEqual(before);
    await expect(picker).not.toContainText('Cursor');
  } finally {
    await f.close();
  }
});

test('Cursor canonical model selection clears billing before the next send', async () => {
  test.skip(live, 'Deterministic managed-runtime boundary');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ billing: true });
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-model-picker')).toBeVisible();
    expect((await f.tab()).aiCreditsRouting.active).toBe(true);
    expect(
      await f.window.evaluate(
        (target) =>
          window.api.chat.changeModel({ ...target, model: 'cursor-default' }),
        f.target,
      ),
    ).toBe(true);
    const selected = await f.tab();
    for (const key of [
      'aiCreditsRouting',
      'subscriptionBillingOverride',
      'billingExplicitlyChosen',
    ])
      expect(selected).not.toHaveProperty(key);
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Cursor',
    );
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// MCP over ACP: the app's own tools and selected plugin MCP servers reach the
// (fixture) Cursor CLI as ACP `mcpServers`; plugin calls go through the shared
// approval card, app calls do not, and an MCP completion the host never
// decided stops the session.
// ---------------------------------------------------------------------------

const MCP_FIXTURE_SERVER_ID = 'e2e-mcp';
const MCP_FIXTURE_SERVER_NAME = 'E2E MCP Fixture';

// A loopback Streamable-HTTP-style MCP server owned by the test: POST JSON-RPC
// only, one `echo` tool. The app proxies it and the fixture agent calls it.
async function startMcpFixtureServer() {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    const message = body ? JSON.parse(body) : null;
    if (!message || !('id' in message)) {
      response.writeHead(204);
      response.end();
      return;
    }
    const reply = (result) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-mcp-fixture', version: '1.0.0' },
      });
      return;
    }
    if (message.method === 'tools/list') {
      reply({
        tools: [
          {
            name: 'echo',
            description: 'Echoes a message.',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      });
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message.params);
      reply({
        content: [
          {
            type: 'text',
            text: `E2E_MCP_ECHO:${message.params?.arguments?.message ?? ''}`,
          },
        ],
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown method ${message.method}` },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function seedMcpFixtureServer(userDataDir, url) {
  const now = '2026-09-12T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: MCP_FIXTURE_SERVER_ID,
          name: MCP_FIXTURE_SERVER_NAME,
          description: 'Loopback MCP fixture',
          type: 'http',
          url,
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
}

function readCursorProfileFile(userDataDir, name) {
  const root = cursorSessionsDir(userDataDir);
  return readFileSync(path.join(root, readdirSync(root)[0], name), 'utf8');
}

async function connectCursorAndOpenChat(window, driver, chatId) {
  await driver.waitForShell();
  await driver.openSettings();
  await driver.openSettingsSection('experiments');
  await window.getByTestId('cursor-connect').click();
  await expectCursorConnected(window);
  await driver.closeSettings();
  await driver.openMainPage();
  await driver.selectWorktree('demo-main');
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

for (const decision of ['allow', 'deny']) {
  test(`Cursor child MCP checks Ask policy once at execution: ${decision}`, async () => {
    test.skip(live, 'Deterministic MCP execution gate');
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-child-mcp-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const mcp = await startMcpFixtureServer();
    seedMcpFixtureServer(userDataDir, mcp.url);
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'cursor',
      tabs: [
        {
          id: 'cursor-child-mcp',
          title: 'Cursor child MCP',
          model: 'cursor-default',
          approvalMode: 'ask',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [
              { serverId: MCP_FIXTURE_SERVER_ID, configId: 'default' },
            ],
          },
        },
      ],
    });
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      const panel = await connectCursorAndOpenChat(
        window,
        driver,
        'cursor-child-mcp',
      );
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await chooseSettingsOption(
        window.getByTestId('settings-managed-delegation-mode'),
        'explicit-only',
      );
      await driver.closeSettings();
      await panel
        .getByRole('textbox')
        .first()
        .fill('Please delegate. CURSOR_DELEGATION_PARENT CURSOR_CHILD_MCP');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      const runRoot = path.join(
        userDataDir,
        'workspaces',
        'demo-ts-pnpm-vite',
        'worktree-data',
        'demo-main',
        'delegation',
      );
      const childProfile = () => {
        const runs = path.join(runRoot, 'runs');
        if (!existsSync(runs)) return undefined;
        const file = readdirSync(runs).find((name) => name.endsWith('.json'));
        if (!file) return undefined;
        const run = JSON.parse(readFileSync(path.join(runs, file), 'utf8'));
        return path.join(runRoot, 'cursor-sessions', run.state.delegationId);
      };
      const admitted = () => {
        const profile = childProfile();
        return profile && existsSync(path.join(profile, 'mcp-admitted'));
      };
      const card = panel.getByTestId('tool-approval-card');
      // Approve only the parent's spawn/watch. A child's echo must not prompt
      // until the actual HTTP call reaches its execution transport.
      for (let step = 0; step < 4 && !admitted(); step++) {
        await expect
          .poll(async () => Boolean(admitted()) || (await card.isVisible()), {
            timeout: 30000,
          })
          .toBe(true);
        if (admitted()) break;
        await expect(card).not.toContainText('echo');
        await card.getByTestId('tool-approval-allow').click();
      }
      await expect.poll(admitted, { timeout: 15000 }).toBe(true);
      expect(mcp.calls).toHaveLength(0);
      writeFileSync(path.join(childProfile(), 'mcp-execute'), 'execute');
      // Watch registration may still be awaiting its own parent approval.
      for (let step = 0; step < 3; step++) {
        await expect(card).toBeVisible({ timeout: 15000 });
        if ((await card.innerText()).includes('echo')) break;
        await card.getByTestId('tool-approval-allow').click();
      }
      await expect(card).toContainText('echo');
      expect(mcp.calls).toHaveLength(0);
      await card.getByTestId(`tool-approval-${decision}`).click();
      await expect
        .poll(
          () => {
            const files = readdirSync(path.join(runRoot, 'runs')).filter(
              (name) => name.endsWith('.json'),
            );
            return JSON.parse(
              readFileSync(path.join(runRoot, 'runs', files[0]), 'utf8'),
            ).state.status;
          },
          { timeout: 15000 },
        )
        .toBe('completed');
      expect(mcp.calls).toHaveLength(decision === 'allow' ? 1 : 0);
      await expect(card.filter({ hasText: 'echo' })).toHaveCount(0);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      await mcp.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

test('Cursor chat reaches an app tool over MCP through the shared approval card', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-mcp-app-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        branchNamingInstructions: 'CURSOR_MCP_E2E_BRANCH_RULE',
        localMemoryEnabled: true,
      },
    }),
  );
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        'CURSOR_CHAT_E2E_MCP_APP: Read my branch naming preference with GetGitPreferences.',
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    // The app's own tools are checked the way Claude checks its Canopy MCP
    // tools, so Ask mode shows the shared card for the MCP call.
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Cursor wants to use GetGitPreferences');
    await expect(card).toContainText('GetGitPreferences');
    await card.getByTestId('tool-approval-allow').click();
    await expect(card).toHaveCount(0);
    // The tool result spans several markdown lines, so match the panel text
    // rather than one text node.
    await expect(panel).toContainText('MCP_RESULT:', { timeout: 15_000 });
    await expect(panel).toContainText('CURSOR_MCP_E2E_BRANCH_RULE');
    await expect(panel).toContainText('Git preferences for branch-name');
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    const servers = JSON.parse(
      readCursorProfileFile(userDataDir, 'fixture-mcp-servers.json'),
    );
    expect(servers.map((server) => server.name)).toEqual([
      'canopy',
      'canopy_ui',
    ]);
    expect(servers[0]).toMatchObject({
      type: 'http',
      headers: [
        { name: 'Authorization', value: expect.stringMatching(/^Bearer /) },
      ],
    });
    expect(servers[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/canopy\/mcp\//);
    expect(servers[1].url).toBe(`${servers[0].url}/ui`);
    const prompt = readCursorProfileFile(userDataDir, 'fixture-prompt.txt');
    expect(prompt).toContain('MCP tools on the canopy and canopy_ui servers');
    expect(prompt).toContain('Use GetScriptOutput to inspect setup');
    expect(prompt).toContain('SaveMemory');
    expect(prompt).not.toMatch(
      /mcp__canopy__|GetCodeGraphContext|StartForkedAgent/,
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

/** A user-authored skill the picker lists without a lock entry. */
function seedCustomSkill(userDataDir, name) {
  const directory = path.join(userDataDir, 'skills', 'custom:app', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Cursor E2E ${name}\n---\nUse ${name}.\n`,
  );
}

function seedCursorInventoryRow(userDataDir, name) {
  writeFileSync(
    path.join(userDataDir, 'invocable-inventory-cache.json'),
    JSON.stringify({
      version: 3,
      builtAt: new Date().toISOString(),
      entries: [
        {
          id: `cursor:skill:custom%3Aapp:${name}`,
          provider: 'cursor',
          kind: 'skill',
          name,
          description: `Cursor E2E ${name}`,
          displayName: `/${name}`,
          insertText: `/${name} `,
          invocationKey: `/${name}`,
          enableRef: { kind: 'skill', sourceId: 'custom:app', skillName: name },
          sourceLabel: 'Custom',
        },
      ],
    }),
  );
}

function readCursorCapabilities(userDataDir) {
  return JSON.parse(
    readCursorProfileFile(userDataDir, 'fixture-capabilities.json'),
  );
}

function seedInheritedCursorCapabilities(userDataDir) {
  // The harness relocates the home roots a Cursor chat inherits from
  // (CANOPY_CURSOR_USER_HOME) and CLAUDE_CONFIG_DIR under provider-state.
  const home = path.join(userDataDir, 'provider-state', 'home');
  const claude = path.join(userDataDir, 'provider-state', 'claude');
  for (const [root, name] of [
    [path.join(home, '.cursor', 'skills'), 'home-review'],
    [path.join(claude, 'skills'), 'claude-review'],
  ]) {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Inherited ${name}\n---\nUse ${name}.\n`,
    );
  }
  mkdirSync(path.join(claude, 'commands'), { recursive: true });
  writeFileSync(
    path.join(claude, 'commands', 'ship.md'),
    '# Ship\n\nShip $ARGUMENTS.\n',
  );
  // A plugin the Cursor app downloaded (completed), and one it did not finish.
  const cache = path.join(home, '.cursor', 'plugins', 'cache', 'cursor-public');
  const complete = path.join(cache, 'demo-plugin', 'aaaa1111');
  mkdirSync(path.join(complete, '.cursor-plugin'), { recursive: true });
  // The manifest lists its command as a file, the way the published
  // `parallel` plugin does; the conventional folder holds the same file.
  writeFileSync(
    path.join(complete, '.cursor-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'demo-plugin',
      skills: './skills/',
      commands: ['commands/plugin-ship.md'],
    }),
  );
  mkdirSync(path.join(complete, 'skills', 'plugin-review'), {
    recursive: true,
  });
  writeFileSync(
    path.join(complete, 'skills', 'plugin-review', 'SKILL.md'),
    '---\nname: plugin-review\ndescription: From a Cursor plugin\n---\nUse plugin-review.\n',
  );
  mkdirSync(path.join(complete, 'commands'), { recursive: true });
  writeFileSync(
    path.join(complete, 'commands', 'plugin-ship.md'),
    '# Plugin ship\n\nShip from the plugin.\n',
  );
  writeFileSync(path.join(complete, '.cache-complete'), '');
  const incomplete = path.join(cache, 'half-plugin', 'bbbb2222');
  mkdirSync(path.join(incomplete, 'skills', 'half-skill'), { recursive: true });
  writeFileSync(
    path.join(incomplete, 'skills', 'half-skill', 'SKILL.md'),
    '# half\n',
  );
  // Home MCP configuration stays isolated and must never reach the chat's HOME.
  writeFileSync(
    path.join(home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: { leak: { command: 'node', args: ['-e', '0'] } },
    }),
  );
  return { home, claude };
}

test('Cursor chat loads a skill picked in the plugin picker from its private Cursor root', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-skills-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCustomSkill(userDataDir, 'review');
  const modelOnlyDir = path.join(
    userDataDir,
    'provider-state',
    'home',
    '.cursor',
    'skills',
    'model-guidance',
  );
  mkdirSync(modelOnlyDir, { recursive: true });
  writeFileSync(
    path.join(modelOnlyDir, 'SKILL.md'),
    '---\nname: model-guidance\ndescription: Model guidance\nuser-invocable: false\n---\nFollow this guidance.\n',
  );
  // A catalog plugin whose only members are a skill and a command: the
  // picker's preview must list both for a Cursor chat (#4889; it once listed
  // MCP servers only).
  const kitDetails = {
    skills: [
      {
        name: 'kit-review',
        description: 'Review with the kit',
        path: 'skills/kit-review',
      },
    ],
    agents: [],
    commands: [
      {
        name: 'kit-ship',
        description: 'Ship with the kit',
        filePath: 'commands/kit-ship.md',
      },
    ],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      {
        name: 'review-kit',
        description: 'A skill and a command, no MCP server.',
        details: kitDetails,
        facets: {
          claude: {
            provider: 'claude',
            mode: 'native',
            name: 'review-kit',
            details: kitDetails,
            installLocation: '/tmp/demo-market',
            sourcePath: 'plugins/review-kit',
          },
        },
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-skills',
        title: 'Cursor skills',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1100, height: 830 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(
      window,
      driver,
      'cursor-skills',
    );
    await panel.getByTestId('chat-input-plus-button').click();
    await window.getByTestId('chat-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search by name…').fill('review-kit');
    const kitRow = dialog
      .locator('tbody tr')
      .filter({ hasText: 'review-kit' })
      .first();
    await kitRow.getByTestId('plugin-members-toggle').click();
    // The preview lists what a Cursor session loads from the plugin: its
    // skill and its command, not only MCP servers.
    const kitCapabilities = kitRow.getByRole('list', {
      name: 'review-kit capabilities',
    });
    await expect(kitCapabilities).toContainText('kit-review');
    await expect(kitCapabilities).toContainText('kit-ship');
    await dialog.getByPlaceholder('Search by name…').fill('review');
    // Skill rows are ordinary selections on a Cursor chat now.
    const checkbox = dialog.getByRole('checkbox', {
      name: 'Select review',
      exact: true,
    });
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // The CLI discovered the copied skill under the chat's own HOME and
    // advertised it; the host found nothing missing.
    const capabilities = readCursorCapabilities(userDataDir);
    expect(capabilities.skills).toEqual(['model-guidance', 'review']);
    expect(capabilities.invocableSkills).toEqual(['review']);
    expect(capabilities.commands).toEqual([]);
    expect(capabilities.home).toMatch(/cursor-sessions\/[0-9a-f]{64}\/home$/);
    expect(
      readFileSync(
        path.join(capabilities.home, '.cursor', 'skills', 'review', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Use review.');
    const prompt = readCursorProfileFile(userDataDir, 'fixture-prompt.txt');
    expect(prompt).toContain(
      'Selected skills and slash commands are loaded by Cursor itself',
    );
    expect(prompt).not.toContain('Skills, slash commands');
    await expect(
      panel.getByText('not available in Cursor chats', { exact: false }),
    ).toHaveCount(0);
    await expect(
      panel.getByText('Cursor did not load', { exact: false }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor composer lists inventory rows, enables the pick, and sends its id to the CLI', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-slash-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCustomSkill(userDataDir, 'review');
  seedCursorInventoryRow(userDataDir, 'review');
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-slash',
        title: 'Cursor slash',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1100, height: 830 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(
      window,
      driver,
      'cursor-slash',
    );
    const composer = panel.getByRole('textbox').first();
    await composer.click();
    await composer.fill('/');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(menu).toBeVisible();
    await menu.getByTestId('chat-input-capability-review').click();
    await expect(menu).toHaveCount(0);
    await expect(composer).toContainText('/review');
    await composer.press('End');
    await composer.pressSequentially(
      'CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.',
    );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // Picking the row enabled the skill for the chat, the turn materialized
    // it, and the reference reached the CLI unchanged where its own parser
    // attaches the skill.
    const capabilities = readCursorCapabilities(userDataDir);
    expect(capabilities.skills).toEqual(['review']);
    const prompt = readCursorProfileFile(userDataDir, 'fixture-prompt.txt');
    expect(prompt).toContain('/review CURSOR_CHAT_E2E_TEXT');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor chat inherits the skills and commands installed for the user’s own CLIs', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-inherited-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { home } = seedInheritedCursorCapabilities(userDataDir);
  // A Canopy skill the chat selected shares the inherited claude-review's
  // name: the pick keeps `/claude-review` in the chat root, the inherited
  // copy is `/claude-review-1`, and the menu keeps the pick reachable.
  seedCustomSkill(userDataDir, 'claude-review');
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-inherited',
        title: 'Cursor inherited',
        model: 'cursor-default',
        approvalMode: 'ask',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:app', skillName: 'claude-review' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1100, height: 830 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(
      window,
      driver,
      'cursor-inherited',
    );
    const composer = panel.getByRole('textbox').first();
    await composer.fill(
      'CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.',
    );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // Beside the one pick, the CLI found the user's skills and command under
    // the chat's own HOME; the home MCP file did not come along.
    const capabilities = readCursorCapabilities(userDataDir);
    // The completed cached plugin's members are inherited; the unfinished
    // download's are not. The inherited claude-review takes the suffix.
    expect(capabilities.skills).toEqual([
      'claude-review',
      'claude-review-1',
      'home-review',
      'plugin-review',
    ]);
    expect(capabilities.commands).toEqual(['plugin-ship', 'ship']);
    expect(
      readFileSync(
        path.join(
          capabilities.home,
          '.cursor',
          'skills',
          'home-review',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).toContain('Use home-review.');
    expect(
      existsSync(path.join(capabilities.home, '.cursor', 'mcp.json')),
    ).toBe(false);
    await expect(
      panel.getByText('Cursor did not load', { exact: false }),
    ).toHaveCount(0);
    await expect(
      panel.getByText('could not be loaded', { exact: false }),
    ).toHaveCount(0);
    // The slash menu lists the inherited rows once the turn refreshed the
    // inventory; choosing one inserts its id.
    await composer.click();
    await composer.fill('/');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(menu).toBeVisible();
    await expect(
      menu.getByTestId('chat-input-capability-home-review'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(menu.getByTestId('chat-input-capability-ship')).toBeVisible();
    // The pick and the inherited claude-review share a name: the menu keeps
    // the pick's row (the chat root gives it the base id) and the inherited
    // copy, whose cached text it already claimed, yields. Choosing the row
    // inserts the pick.
    await menu.getByTestId('chat-input-capability-claude-review').click();
    await expect(menu).toHaveCount(0);
    await expect(composer).toContainText('/claude-review');
    await expect(composer).not.toContainText('/claude-review-1');
    // A plugin installed from the Cursor app while the chat is open, and a
    // skill dropped into a home folder: no Canopy mutation and no Cursor turn
    // marks the inventory stale, so opening the menu again is what notices.
    const latePlugin = path.join(
      home,
      '.cursor',
      'plugins',
      'cache',
      'cursor-public',
      'late-plugin',
      'cccc3333',
    );
    mkdirSync(path.join(latePlugin, 'skills', 'late-plugin-skill'), {
      recursive: true,
    });
    writeFileSync(
      path.join(latePlugin, 'skills', 'late-plugin-skill', 'SKILL.md'),
      '---\nname: late-plugin-skill\ndescription: Installed later\n---\nUse late-plugin-skill.\n',
    );
    writeFileSync(path.join(latePlugin, '.cache-complete'), '');
    mkdirSync(path.join(home, '.cursor', 'skills', 'late-review'), {
      recursive: true,
    });
    writeFileSync(
      path.join(home, '.cursor', 'skills', 'late-review', 'SKILL.md'),
      '---\nname: late-review\ndescription: Late\n---\nUse late-review.\n',
    );
    // A served list re-checks the inherited folders at most once a second;
    // the open above already spent that second's check.
    await window.waitForTimeout(1_200);
    await composer.fill('/');
    await expect(menu).toBeVisible();
    await expect(
      menu.getByTestId('chat-input-capability-late-plugin-skill'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      menu.getByTestId('chat-input-capability-late-review'),
    ).toBeVisible();
    await menu.getByTestId('chat-input-capability-late-plugin-skill').click();
    await expect(menu).toHaveCount(0);
    await expect(composer).toContainText('/late-plugin-skill');
    await composer.press('End');
    // The fixture answers every scripted text prompt with the same line, so
    // the second reply is the second copy of it.
    await composer.pressSequentially(' CURSOR_CHAT_E2E_TEXT: Second turn.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toHaveCount(2, { timeout: 30_000 });
    expect(readCursorCapabilities(userDataDir).skills).toEqual([
      'claude-review',
      'claude-review-1',
      'home-review',
      'late-plugin-skill',
      'late-review',
      'plugin-review',
    ]);
    expect(readCursorProfileFile(userDataDir, 'fixture-prompt.txt')).toContain(
      '/late-plugin-skill',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

for (const decision of ['allow', 'deny']) {
  test(`Cursor chat plugin MCP tool: ${decision} governs the call`, async () => {
    test.skip(live, 'Deterministic managed-runtime regression');
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-mcp-plugin-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const mcp = await startMcpFixtureServer();
    seedMcpFixtureServer(userDataDir, mcp.url);
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'cursor',
      tabs: [
        {
          id: 'cursor-mcp',
          title: 'Cursor MCP',
          model: 'cursor-default',
          approvalMode: 'ask',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [
              { serverId: MCP_FIXTURE_SERVER_ID, configId: 'default' },
            ],
          },
        },
      ],
    });
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      const panel = await connectCursorAndOpenChat(
        window,
        driver,
        'cursor-mcp',
      );
      await panel
        .getByRole('textbox')
        .first()
        .fill('CURSOR_CHAT_E2E_MCP_PLUGIN: Call the echo tool.');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      const card = panel.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText('Cursor wants to use echo');
      await expect(card).toContainText('echo');
      expect(mcp.calls).toHaveLength(0);
      await card.getByTestId(`tool-approval-${decision}`).click();
      await expect(card).toHaveCount(0);
      if (decision === 'allow') {
        await expect(
          panel.getByText('MCP_RESULT: E2E_MCP_ECHO:hello', { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        expect(mcp.calls).toEqual([
          { name: 'echo', arguments: { message: 'hello' } },
        ]);
      } else {
        await expect(
          panel.getByText('MCP tool denied.', { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        expect(mcp.calls).toHaveLength(0);
      }
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        panel.getByText('without reaching the approval hook'),
      ).toHaveCount(0);
      const servers = JSON.parse(
        readCursorProfileFile(userDataDir, 'fixture-mcp-servers.json'),
      );
      const plugin = servers.find((server) =>
        /e2e-mcp-fixture/i.test(server.name),
      );
      expect(plugin).toMatchObject({ type: 'http' });
      expect(plugin.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      await mcp.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

test('Cursor chat prompts for a plugin MCP tool the CLI never asked permission for and Deny refuses it', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-ungated-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const mcp = await startMcpFixtureServer();
  seedMcpFixtureServer(userDataDir, mcp.url);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: MCP_FIXTURE_SERVER_ID, configId: 'default' },
          ],
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MCP_PLUGIN UNGATED: Call echo without asking.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    // The CLI skipped the ACP permission request, so the proxied plugin
    // route raises the same card before the call reaches the server...
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Cursor wants to use echo');
    expect(mcp.calls).toHaveLength(0);
    await card.getByTestId('tool-approval-deny').click();
    await expect(card).toHaveCount(0);
    // ...and the denial is the call's result: the gate decided it, so the
    // failed completion does not stop the session.
    await expect(
      panel.getByText('MCP_RESULT: echo was denied.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(mcp.calls).toHaveLength(0);
    await expect(
      panel.getByText('without reaching the approval hook'),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await mcp.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor chat plugin picker selects an MCP server that reaches the next turn', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-mcp-picker-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const mcp = await startMcpFixtureServer();
  seedMcpFixtureServer(userDataDir, mcp.url);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1100, height: 830 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel.getByTestId('chat-input-plus-button').click();
    const pluginsButton = window.getByTestId('chat-plugins-button');
    await expect(pluginsButton).toBeVisible();
    await expect(pluginsButton).toBeEnabled();
    await expect(window.getByTestId('chat-input-commands-button')).toHaveCount(
      0,
    );
    await pluginsButton.click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByPlaceholder('Search by name…')
      .fill(MCP_FIXTURE_SERVER_NAME);
    const checkbox = dialog.getByRole('checkbox', {
      name: `Select ${MCP_FIXTURE_SERVER_NAME}`,
    });
    // Deferred plugin loading needs a mid-turn reload, which a Cursor turn
    // cannot do, so the toggle is not offered here.
    await expect(
      dialog.getByTestId('chat-plugins-deferred-tools-toggle'),
    ).toHaveCount(0);
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MCP_PLUGIN: Call the echo tool.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Cursor wants to use echo');
    await card.getByTestId('tool-approval-allow').click();
    await expect(
      panel.getByText('MCP_RESULT: E2E_MCP_ECHO:hello', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(mcp.calls).toHaveLength(1);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await mcp.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor from New Task keeps a plugin picker selection and hands its MCP server to the chat', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-home-mcp-'));
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: true,
  });
  const mcp = await startMcpFixtureServer();
  seedMcpFixtureServer(userDataDir, mcp.url);
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1200, height: 860 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home.getByTestId('home-surface')).toHaveAttribute(
      'data-workspace-selected',
      'true',
    );
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, 'cursor-default');
    await expect(home.getByTestId('chat-model-picker')).toContainText('Cursor');
    // New tasks start in Full Access (CAN-3055); pick Ask so the MCP call
    // below raises the shared approval card.
    await home.getByTestId('approval-mode-picker').click();
    await window.getByTestId('approval-mode-option-ask').click();
    await expect(home.getByTestId('approval-mode-picker')).toHaveAttribute(
      'aria-label',
      'Tool approval mode, current mode Ask',
    );
    await home.getByTestId('home-composer-plus-button').click();
    await window.getByTestId('home-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByPlaceholder('Search by name…')
      .fill(MCP_FIXTURE_SERVER_NAME);
    const checkbox = dialog.getByRole('checkbox', {
      name: `Select ${MCP_FIXTURE_SERVER_NAME}`,
    });
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MCP_PLUGIN: Call the echo tool.');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    const panel = window
      .getByTestId('panel-content-chat')
      .filter({ hasText: 'CURSOR_CHAT_E2E_MCP_PLUGIN:' });
    await expect(panel).toBeVisible();
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText('Cursor wants to use echo');
    await card.getByTestId('tool-approval-allow').click();
    await expect(
      panel.getByText('MCP_RESULT: E2E_MCP_ECHO:hello', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(mcp.calls).toEqual([
      { name: 'echo', arguments: { message: 'hello' } },
    ]);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await mcp.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor read-only mode denies an app WatchCommand without a prompt', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-watch-plan-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
        planMode: true,
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await expect(
      panel.getByTestId('chat-input-plan-mode-inline-button'),
    ).toHaveAttribute('aria-pressed', 'true');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MCP_WATCH: Register a watcher probe.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('MCP tool denied.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('tool-approval-card')).toHaveCount(0);
    expect(
      existsSync(
        path.join(seeded.workspaces[0].worktreePath, 'cursor-watch-result.txt'),
      ),
    ).toBe(false);
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor chat prompts for an app WatchCommand the CLI never asked permission for and Deny refuses it', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-watch-ungated-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        'CURSOR_CHAT_E2E_MCP_WATCH UNGATED: Register a watcher probe without asking.',
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    // The CLI skipped the ACP permission request, so the app's own execution
    // seam raises the same card before anything runs...
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Cursor wants to use WatchCommand');
    await card.getByTestId('tool-approval-deny').click();
    await expect(card).toHaveCount(0);
    // ...and the denial is the call's result: the gate decided it, so the
    // failed completion does not stop the session.
    await expect(
      panel.getByText('MCP_RESULT: WatchCommand was denied.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByText('without reaching the approval hook'),
    ).toHaveCount(0);
    const result = JSON.parse(
      readCursorProfileFile(userDataDir, 'fixture-mcp-result.json'),
    );
    expect(result).toMatchObject({ toolName: 'WatchCommand', isError: true });
    expect(result.text).toContain('WatchCommand was denied.');
    expect(
      existsSync(
        path.join(seeded.workspaces[0].worktreePath, 'cursor-watch-result.txt'),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

// The pinned CLI has been observed executing an MCP tool without sending
// session/request_permission (Full Access, a proxied Slack server,
// 2026-09-13). The app's own gates are the effective control then, and a
// completion they decided must not stop the session.
test('Cursor Full Access runs a plugin MCP tool the CLI never asked permission for through the app gate', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-ungated-full-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const mcp = await startMcpFixtureServer();
  seedMcpFixtureServer(userDataDir, mcp.url);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'full-access',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: MCP_FIXTURE_SERVER_ID, configId: 'default' },
          ],
        },
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MCP_PLUGIN UNGATED: Call echo without asking.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('MCP_RESULT: E2E_MCP_ECHO:hello', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(mcp.calls).toEqual([
      { name: 'echo', arguments: { message: 'hello' } },
    ]);
    await expect(panel.getByTestId('tool-approval-card')).toHaveCount(0);
    await expect(
      panel.getByText('without reaching the approval hook'),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await mcp.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor Full Access runs an app WatchCommand the CLI never asked permission for through the app gate', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-mcp-watch-full-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'cursor',
    tabs: [
      {
        id: 'cursor-mcp',
        title: 'Cursor MCP',
        model: 'cursor-default',
        approvalMode: 'full-access',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    const panel = await connectCursorAndOpenChat(window, driver, 'cursor-mcp');
    await panel
      .getByRole('textbox')
      .first()
      .fill(
        'CURSOR_CHAT_E2E_MCP_WATCH UNGATED: Register a watcher probe without asking.',
      );
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(panel.getByText('MCP_RESULT:')).toBeVisible({
      timeout: 15_000,
    });
    const result = JSON.parse(
      readCursorProfileFile(userDataDir, 'fixture-mcp-result.json'),
    );
    expect(result).toMatchObject({ toolName: 'WatchCommand', isError: false });
    await expect(panel.getByTestId('tool-approval-card')).toHaveCount(0);
    await expect(
      panel.getByText('without reaching the approval hook'),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});

test('Cursor-only models remain selectable without hosted billing', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  const id = 'cursor:' + encodeURIComponent('gemini-3.1-pro[]');
  try {
    await f.connection(true);
    await f.openChat();
    await f.window
      .getByTestId('panel-content-chat')
      .getByTestId('chat-model-picker')
      .click();
    const row = f.window.getByTestId('chat-model-option-' + id);
    // Wait for discovery before reading the section the row landed in.
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await expect(
      f.window
        .getByRole('group', { name: 'Cursor', exact: true })
        .getByRole('menuitemradio'),
    ).toHaveCount(1);
    await row.click();
    await expect
      .poll(f.tab)
      .toMatchObject({ model: id, providerType: 'cursor' });
    expect((await f.tab()).aiCreditsRouting?.active).not.toBe(true);
  } finally {
    await f.close();
  }
});

// A moderately long catalog has a larger scrollbar thumb than the longest
// catalog, which can expose stale thumb overflow when switching to a short tab.
for (const modelCount of [26, 40]) {
  test(`Home keeps the hosted catalog visible after scrolling ${modelCount} Cursor models`, async () => {
    test.skip(live, 'Deterministic managed-runtime model catalog');
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture({ gatewayModel: true });
    try {
      await connectMockCloudAccount(f.window, 'csk_picker_scroll_e2e');
      await f.connection(true);
      await f.electronApp.evaluate(({ ipcMain }, count) => {
        ipcMain.removeHandler('cursor-connection:models');
        ipcMain.handle('cursor-connection:models', () =>
          Array.from({ length: count }, (_, index) => ({
            id: `cursor:fixture-${index}`,
            rawModelId: `fixture-${index}`,
            label: `Cursor fixture ${String(index).padStart(2, '0')}`,
          })),
        );
      }, modelCount);
      await f.window.getByTestId('sidebar-create-task').click();
      await f.window
        .getByTestId('page-home')
        .getByTestId('chat-model-picker')
        .click();
      const menu = f.window.getByTestId('chat-model-menu');
      const readAnchorGap = () =>
        menu.evaluate((element) => {
          const trigger = document.querySelector(
            '[data-testid="page-home"] [data-testid="chat-model-picker"]',
          );
          if (!trigger) throw new Error('Home model picker trigger missing');
          const surface = element.getBoundingClientRect();
          return trigger.getBoundingClientRect().top - surface.bottom;
        });
      // The Home model menu opens 4px off the composer, like the chat
      // composer's settings menus.
      await expect.poll(readAnchorGap).toBeCloseTo(4, 0);
      const rows = menu.locator('[data-model-id]:visible');
      const cursorRows = menu.locator('[data-model-id^="cursor:"]:visible');
      await expect(cursorRows).toHaveCount(modelCount);
      // One list, so the hosted catalog sits alongside the Cursor models
      // rather than behind a view the user has to find.
      await expect(
        f.window.getByTestId('chat-model-option-e2e-kimi'),
      ).toHaveCount(1);

      await rows.first().hover();
      await f.window.mouse.wheel(0, 1000);
      await expect
        .poll(() =>
          menu.evaluate((element) =>
            [element, ...element.querySelectorAll('*')].some(
              (node) => node.scrollTop > 100,
            ),
          ),
        )
        .toBe(true);
      // Scrolling a long catalog does not drag the menu off its anchor.
      await expect.poll(readAnchorGap).toBeCloseTo(4, 0);

      await f.window.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await f.window
        .getByTestId('page-home')
        .getByTestId('chat-model-picker')
        .click();
      // A reopened menu starts at the top of the list again.
      await expect(rows.first()).toBeInViewport();
      await expect
        .poll(() =>
          menu.evaluate((element) =>
            [element, ...element.querySelectorAll('*')].every(
              (node) => node.scrollTop === 0,
            ),
          ),
        )
        .toBe(true);
      await expect.poll(readAnchorGap).toBeCloseTo(4, 0);
    } finally {
      await f.close();
    }
  });
}

test('Cursor discovers models for Home and applies switches after session restore', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  const gpt = 'gpt-5.6-luna[reasoning=medium]';
  const claude = 'claude-sonnet-4-5[thinking=true,context=200k]';
  const gemini = 'gemini-3.1-pro[]';
  const modelId = (raw) => 'cursor:' + encodeURIComponent(raw);
  try {
    await f.connection(true);
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('chat-model-picker').click();
    const group = f.window.getByRole('group', { name: 'Cursor', exact: true });
    await expect(group.getByRole('menuitemradio')).toHaveCount(1);
    await expect(
      f.window.getByTestId('chat-model-option-' + modelId(gpt)),
    ).toHaveCount(0);
    await f.window.getByTestId('chat-model-more-openai').click();
    await expect(
      f.window.getByTestId('chat-model-option-label-gpt-5.6-luna'),
    ).toHaveText('GPT 5.6 Luna');
    await f.window.getByTestId('chat-model-option-gpt-5.6-luna').click();
    // Cursor's copy is the same row on the Cursor tab.
    await home.getByTestId('chat-model-picker').click();
    await selectModelOnHarness(f.window, 'gpt-5.6-luna', 'cursor');
    await home.getByTestId('chat-model-picker').click();
    // The picker reopens on the last tab; the rest of this flow reads All.
    await f.window.getByTestId('chat-model-harness-tab-all').click();
    const refreshedRegistry = await f.window.evaluate(() =>
      window.api.getModelRegistry(),
    );
    // A pushed catalog update must preserve the discovered labels in the
    // open menu and selected chip, without requiring close/reopen recovery.
    refreshedRegistry.claude[0].label = 'Refreshed Claude label';
    await f.electronApp.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        'model-registry:updated',
        snapshot,
      );
    }, refreshedRegistry);
    await expect(
      f.window.getByTestId(
        'chat-model-option-label-' + refreshedRegistry.claude[0].id,
      ),
    ).toHaveText('Refreshed Claude label');
    await f.window.getByTestId('chat-model-more-openai').click();
    await expect(
      f.window.getByTestId('chat-model-option-label-gpt-5.6-luna'),
    ).toHaveText('GPT 5.6 Luna');
    await expect(home.getByTestId('chat-model-picker')).toContainText(
      'GPT 5.6 Luna',
    );
    // Escape closes the nested More menu before the harness model menu.
    await f.window.keyboard.press('Escape');
    await expect(
      f.window.getByTestId('chat-model-more-group-openai'),
    ).toHaveCount(0);
    await f.window.keyboard.press('Escape');
    await expect(group).toHaveCount(0);

    await home.getByTestId('home-composer-plus-button').click();
    await expect(f.window.getByTestId('home-schedule-button')).toBeDisabled();
    // Plugins stay available for Cursor drafts (MCP servers load).
    await expect(f.window.getByTestId('home-plugins-button')).toBeVisible();
    await f.window.keyboard.press('Escape');
    const reasoning = await cursorReasoningShownOn(home);
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MODEL: first turn');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    const panel = f.window
      .getByTestId('panel-content-chat')
      .filter({ hasText: 'CURSOR_CHAT_E2E_MODEL: first turn' });
    await expect(
      panel.getByText(
        `Cursor model: gpt-5.6-luna[reasoning=${reasoning}]; restored: false`,
        { exact: true },
      ),
    ).toBeVisible();
    for (const raw of [claude, 'default[]', gemini]) {
      if (raw === gemini) {
        await f.window.reload();
        await f.driver.waitForShell();
        await f.openChat();
      }
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await panel.getByTestId('chat-model-picker').click();
      await f.window
        .getByTestId(
          'chat-model-option-' +
            (raw === 'default[]' ? 'cursor-default' : modelId(raw)),
        )
        .click();
      await expect(panel.getByTestId('chat-model-change-pending')).toHaveCount(
        0,
      );
      await panel
        .getByRole('textbox')
        .first()
        .fill('CURSOR_CHAT_E2E_MODEL: next turn');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText(`Cursor model: ${raw}; restored: true`, {
          exact: true,
        }),
      ).toBeVisible();
    }
    const tabs = await f.window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      f.target,
    );
    const selected = tabs.tabs.find((tab) => tab.model === modelId(gemini));
    expect(selected).toMatchObject({
      model: modelId(gemini),
      providerType: 'cursor',
    });
    expect(selected).not.toHaveProperty('aiCreditsRouting');
  } finally {
    await f.close();
  }
});

test('Cursor thinking level follows the advertised model and reaches the CLI', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  const gemini = 'gemini-3.1-pro[]';
  const modelId = (raw) => 'cursor:' + encodeURIComponent(raw);
  try {
    await f.connection(true);
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-more-openai').click();
    await f.window.getByTestId('chat-model-option-gpt-5.6-luna').click();
    // Cursor's copy is the same row on the Cursor tab.
    await home.getByTestId('chat-model-picker').click();
    await selectModelOnHarness(f.window, 'gpt-5.6-luna', 'cursor');
    // The draft offers exactly the levels the Cursor variant declares
    // (reasoning: none/low/medium/high/xhigh), never the native tiers.
    const homeChip = home.getByTestId('home-thinking-level-button');
    await expect(homeChip).toBeVisible();
    const homeLevel = await homeChip.getAttribute('data-thinking-level');
    // The effort panel offers exactly the declared set: the variant's
    // `reasoning` offers none/low/medium/high/xhigh, so `max` is absent.
    const homeSlider = await openEffortSlider(
      f.window,
      homeChip,
      'home-thinking-level-button',
    );
    expect(await readEffortStops(homeSlider)).toEqual([
      'None',
      'Low',
      'Medium',
      'High',
      'Extra High',
    ]);
    await closeEffortPanel(f.window);
    await expect(homeChip).toHaveAttribute('data-thinking-level', homeLevel);
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MODEL: first turn');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    const panel = f.window
      .getByTestId('panel-content-chat')
      .filter({ hasText: 'CURSOR_CHAT_E2E_MODEL: first turn' });
    await expect(
      panel.getByText(
        `Cursor model: gpt-5.6-luna[reasoning=${cursorReasoningFor(homeLevel)}]; restored: false`,
        { exact: true },
      ),
    ).toBeVisible();
    // The chat keeps the draft level; moving it changes the next turn.
    const chip = panel.getByTestId('chat-input-thinking-level-button');
    await expect(chip).toHaveAttribute('data-thinking-level', homeLevel);
    await stepEffortAway(await openEffortSlider(f.window, chip));
    await closeEffortPanel(f.window);
    await expect(chip).not.toHaveAttribute('data-thinking-level', homeLevel);
    const nextLevel = await chip.getAttribute('data-thinking-level');
    expect(['off', 'low', 'medium', 'high', 'xhigh']).toContain(nextLevel);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MODEL: next turn');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(
        `Cursor model: gpt-5.6-luna[reasoning=${cursorReasoningFor(nextLevel)}]; restored: true`,
        { exact: true },
      ),
    ).toBeVisible();
    const tabs = await f.window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      f.target,
    );
    expect(
      tabs.tabs.find(
        (tab) => tab.model === modelId('gpt-5.6-luna[reasoning=medium]'),
      ),
    ).toMatchObject({ modelConfig: { thinkingLevel: nextLevel } });
    // A model without a thought-level option hides the control, and its
    // turn keeps the runtime default.
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-' + modelId(gemini)).click();
    await expect(panel.getByTestId('chat-model-change-pending')).toHaveCount(0);
    await expect(chip).toHaveCount(0);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MODEL: no control');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(`Cursor model: ${gemini}; restored: true`, {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

for (const restored of [false, true]) {
  test(`Cursor slug model labels stay clean ${restored ? 'after an abrupt restart before discovery' : 'and use catalog names in the model menu'}`, async () => {
    test.skip(live, 'Deterministic slug-name ACP model catalog');
    test.setTimeout(120_000);
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture({
      rawModelLabels: true,
      abruptClose: true,
    });
    const raw = 'gemini-3.1-pro[]';
    const id = 'cursor:' + encodeURIComponent(raw);
    const opus =
      'cursor:' + encodeURIComponent('claude-opus-4-5[thinking=true]');
    try {
      await f.connection(true);
      await f.openChat();
      let panel = f.window.getByTestId('panel-content-chat');
      await panel.getByTestId('chat-model-picker').click();
      const option = f.window.getByTestId('chat-model-option-' + id);
      await expect(option).toBeVisible();
      if (!restored) {
        // Named like the native Anthropic and OpenAI rows, not by slug.
        await expect(
          f.window.getByTestId('chat-model-option-label-' + id),
        ).toHaveText('Gemini 3.1 Pro');
        await expect(
          f.window.getByTestId('chat-model-option-label-' + opus),
        ).toHaveText('Opus 4.5');
      }
      await option.click();
      await expect
        .poll(f.tab)
        .toMatchObject({ model: id, providerType: 'cursor' });
      if (restored) {
        await f.restart();
        await f.openChat();
        panel = f.window.getByTestId('panel-content-chat');
        const snapshot = await f.window.evaluate(() =>
          window.api.getModelRegistry(),
        );
        expect(snapshot.cursor ?? []).toHaveLength(0);
      }
      // Names are not persisted, so a restart shows the slug until discovery.
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        restored ? 'gemini-3.1-pro' : 'Gemini 3.1 Pro',
      );
      await expect(panel.getByTestId('chat-model-picker')).not.toContainText(
        '[]',
      );
      // Display cleanup must never change the opaque execution identity.
      await panel
        .getByRole('textbox')
        .first()
        .fill('CURSOR_CHAT_E2E_MODEL: raw label');
      await panel
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      await expect(
        panel.getByText(`Cursor model: ${raw}; restored: false`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}

test('Cursor models use maker groups without duplicating native models', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ sharedModel: true });
  try {
    await f.connection(true);
    await f.openChat();
    await f.window
      .getByTestId('panel-content-chat')
      .getByTestId('chat-model-picker')
      .click();
    const geminiId = 'cursor:' + encodeURIComponent('gemini-3.1-pro[]');
    const gemini = f.window
      .getByTestId('chat-model-option-' + geminiId)
      .filter({ visible: true });
    await expect(gemini).toBeVisible();
    await expect(
      f.window
        .getByRole('group', { name: 'Google', exact: true })
        .filter({ visible: true })
        .getByTestId('chat-model-option-' + geminiId),
    ).toBeVisible();
    await expect(
      f.window
        .getByRole('group', { name: 'Cursor', exact: true })
        .filter({ visible: true })
        .getByRole('menuitemradio'),
    ).toHaveCount(1);
    await expect(
      f.window
        .getByTestId('chat-model-option-gpt-6-astra')
        .filter({ visible: true }),
    ).toHaveCount(1);
    await expect(
      f.window.getByTestId(
        'chat-model-option-cursor:' +
          encodeURIComponent('gpt-6-astra[reasoning=medium]'),
      ),
    ).toHaveCount(0);
    await gemini.click();
    await expect
      .poll(f.tab)
      .toMatchObject({ model: geminiId, providerType: 'cursor' });
  } finally {
    await f.close();
  }
});

test('Cursor accepts opaque vendor model identifiers from discovery through a turn', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ opaqueModel: true });
  const raw = 'vendor:模型~variant';
  const id = 'cursor:' + encodeURIComponent(raw);
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-option-' + id).click();
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Opaque vendor model',
    );
    await expect(panel.getByTestId('chat-model-change-pending')).toHaveCount(0);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MODEL: opaque model');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(`Cursor model: ${raw}; restored: false`, { exact: true }),
    ).toBeVisible();
    expect(await f.tab()).toMatchObject({ model: id, providerType: 'cursor' });
  } finally {
    await f.close();
  }
});

test('Cursor model selection during a turn applies to the next message', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  const raw = 'gpt-5.6-luna[reasoning=medium]';
  const id = 'cursor:' + encodeURIComponent(raw);
  try {
    await f.connection(true);
    await f.openChat();
    const panel = f.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(f.window, 'cursor-default');
    await expect(panel.getByTestId('chat-model-change-pending')).toHaveCount(0);
    // The product defaults to Full access. This flow needs a held approval
    // so the model selection happens while the first turn is still running.
    await panel.getByTestId('approval-mode-picker').click();
    await f.window.getByTestId('approval-mode-option-ask').click();
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_WRITE_MODEL_SWITCH: wait for a decision');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = panel.getByTestId('tool-approval-card');
    await expect(card).toBeVisible();
    if (
      await card
        .getByText('Cursor wants to use Read', { exact: true })
        .isVisible()
    ) {
      await card.getByTestId('tool-approval-allow').click();
    }
    await expect(card).toContainText('Cursor wants to use Write');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(f.window, 'gpt-5.6-luna');
    await expect(panel.getByTestId('chat-model-change-pending')).toHaveCount(0);
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'GPT 5.6 Luna',
    );
    // Wait for the IPC outcome as well as the optimistic renderer update.
    // The live provider must accept the same selection without a rejected
    // promise after the canonical tab has already been committed.
    expect(
      await f.window.evaluate(
        ({ target, model }) =>
          window.api.chat.changeModel({ ...target, model }),
        { target: f.target, model: id },
      ),
    ).toBe(true);

    expect(await f.tab()).toMatchObject({ model: id, providerType: 'cursor' });
    await card.getByTestId('tool-approval-deny').click();
    await expect(
      panel.getByText('Cursor write model: default[]', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0);
    // The next turn runs the switched model at the effort the composer shows.
    const reasoning = await cursorReasoningShownOn(panel);
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_MODEL: next message');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText(
        `Cursor model: gpt-5.6-luna[reasoning=${reasoning}]; restored: true`,
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('Cursor keeps discovered models across picker mounts and failed refreshes', async () => {
  test.skip(live, 'Deterministic managed-runtime model catalog');
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture, openCursorPickerDuringRefresh } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture();
  try {
    const refresh = await openCursorPickerDuringRefresh(f);
    const expectDiscoveredModels = async () => {
      await expect(refresh.group.getByRole('menuitemradio')).toHaveCount(1);
      await expect(
        f.window.getByRole('group', { name: 'Google', exact: true }),
      ).toContainText('Gemini 3.1 Pro');
    };
    await expectDiscoveredModels();
    await refresh.release();
    await expect(
      f.window.getByText(
        'Could not load Cursor models. Reopen this menu to try again.',
      ),
    ).toBeVisible();
    await expectDiscoveredModels();
    const snapshot = await f.window.evaluate(() =>
      window.api.getModelRegistry(),
    );
    await f.electronApp.evaluate(({ BrowserWindow }, snapshot) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('model-registry:updated', snapshot);
    }, snapshot);
    await expect(
      f.window.getByText(
        'Could not load Cursor models. Reopen this menu to try again.',
      ),
    ).toHaveCount(0);
    await expectDiscoveredModels();
    await f.window.keyboard.press('Escape');
    await f.connection(false);
    await f.openChat();
    await f.window
      .getByTestId('panel-content-chat')
      .getByTestId('chat-model-picker')
      .click();
    await expect(refresh.group).toHaveCount(0);
    await f.window.keyboard.press('Escape');
    await f.connection(true);
    await f.openChat();
    await f.window
      .getByTestId('panel-content-chat')
      .getByTestId('chat-model-picker')
      .click();
    // Reconnect discovers a fresh host catalog independently of the held
    // picker refresh. The renderer must hydrate it immediately too.
    await expectDiscoveredModels();
    await refresh.release();
  } finally {
    await f.close();
  }
});
