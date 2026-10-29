import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startPerformanceMonitor } from '../performance/monitor.mjs';
import { summarize } from '../performance/statistics.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PRIMARY_CHAT_ID = 'release-like-mcp-primary';
const SECONDARY_CHAT_ID = 'release-like-mcp-secondary';
const TOOL_NAME = 'mcp__fixture-server__fixture_query';
const EVIDENCE_PATH =
  process.env.CANOPY_RELEASE_MCP_EVIDENCE_PATH ??
  path.join(os.tmpdir(), 'codex-mcp-release-like-evidence.json');

function mcpMessages(turns, callsPerTurn) {
  return Array.from({ length: turns }, (_, turn) => ({
    id: `release-like-mcp-message-${turn}`,
    role: 'system',
    timestamp: turn + 1,
    blocks: Array.from({ length: callsPerTurn }, (_, call) => {
      const toolUseId = `codex-release-like-${turn}-${call}`;
      return [
        {
          type: 'tool_use',
          toolUseId,
          toolName: TOOL_NAME,
          input: JSON.stringify({
            turn,
            call,
            query: `fixture-${turn}-${call}`,
          }),
        },
        {
          type: 'tool_result',
          toolUseId,
          toolName: TOOL_NAME,
          output: `fixture result ${turn}-${call}`,
          isError: false,
        },
      ];
    }).flat(),
  }));
}

async function processSnapshot(electronApp) {
  return electronApp.evaluate(({ app }) =>
    app.getAppMetrics().reduce(
      (summary, metric) => ({
        workingSetMb:
          summary.workingSetMb + (metric.memory?.workingSetSize ?? 0) / 1024,
        cpuPercent: summary.cpuPercent + (metric.cpu?.percentCPUUsage ?? 0),
        processCount: summary.processCount + 1,
      }),
      { workingSetMb: 0, cpuPercent: 0, processCount: 0 },
    ),
  );
}

test('release-like MCP-heavy transcript remains interactive and memory-stable', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-mcp-release-like-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: PRIMARY_CHAT_ID,
    tabs: [
      {
        id: PRIMARY_CHAT_ID,
        title: 'MCP-heavy primary',
        messages: mcpMessages(160, 3),
      },
      {
        id: SECONDARY_CHAT_ID,
        title: 'MCP-heavy secondary',
        messages: mcpMessages(80, 3),
      },
    ],
  });

  const iterations = Number(process.env.CANOPY_RELEASE_MCP_ITERATIONS ?? 3);
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 100)
    throw new Error('Release MCP iteration count must be 3..100');
  let monitor;
  let launched;
  try {
    launched = await launchCanopy({
      userDataDir,
      buildKind: 'production',
      env: { CANOPY_ENV: 'production' },
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const primaryPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${PRIMARY_CHAT_ID}"]`,
    );
    await expect(primaryPanel).toBeVisible();
    const scroll = primaryPanel.getByTestId('chat-message-list-scroll');
    await expect(scroll).toBeVisible();
    const windowState = await launched.electronApp.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
    );
    const before = await processSnapshot(launched.electronApp);
    const beforeDomNodes = await primaryPanel.evaluate(
      (element) => element.ownerDocument.getElementsByTagName('*').length,
    );

    const durations = [];
    if (process.env.CANOPY_RELEASE_MCP_MONITOR === '1')
      monitor = await startPerformanceMonitor({
        page: window,
        electronApp: launched.electronApp,
        sampleIntervalMs: 250,
      });
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const iterationStartedAt = performance.now();
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollTop))
        .toBeLessThanOrEqual(1);
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });

      const card = primaryPanel
        .locator(
          `[data-testid="chat-tool-call"][data-tool-name="${TOOL_NAME}"]`,
        )
        .last();
      await expect(card).toBeVisible();
      await card.getByRole('button').click();
      await expect(card.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(card).toContainText('Result');
      await card.getByRole('button').click();

      const composer = primaryPanel.getByRole('textbox').first();
      await composer.fill('');
      if (monitor)
        await window.evaluate(() => {
          window.__CANOPY_DESKTOP_PERF__.typingProbeActive = true;
        });
      await composer.pressSequentially(
        `release-like MCP typing probe ${iteration} `.repeat(3),
      );
      if (monitor)
        await window.evaluate(() => {
          window.__CANOPY_DESKTOP_PERF__.typingProbeActive = false;
        });
      await expect(composer).toContainText(
        `release-like MCP typing probe ${iteration}`,
      );
      await composer.fill('');

      await window
        .getByTestId(`panel-tab-panel-chat-${SECONDARY_CHAT_ID}`)
        .click();
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${SECONDARY_CHAT_ID}`),
      ).toHaveAttribute('aria-selected', 'true');
      await window
        .getByTestId(`panel-tab-panel-chat-${PRIMARY_CHAT_ID}`)
        .click();
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${PRIMARY_CHAT_ID}`),
      ).toHaveAttribute('aria-selected', 'true');
      durations.push(performance.now() - iterationStartedAt);
    }

    const monitoring = await monitor?.stop();
    if (monitoring) {
      writeFileSync(
        EVIDENCE_PATH.replace('.json', '-monitoring.json'),
        JSON.stringify(monitoring),
      );
      await testInfo.attach('production-monitoring.json', {
        body: JSON.stringify(monitoring),
        contentType: 'application/json',
      });
    }
    const after = await processSnapshot(launched.electronApp);
    const afterDomNodes = await primaryPanel.evaluate(
      (element) => element.ownerDocument.getElementsByTagName('*').length,
    );
    const workingSetGrowthMb = after.workingSetMb - before.workingSetMb;
    const domNodeGrowth = afterDomNodes - beforeDomNodes;

    const evidence = {
      buildKind: 'production',
      windowState,
      warmupIterationMs: durations[0],
      measuredCycleMs: durations.slice(1),
      cycleSummary: summarize(durations.slice(1)),
      monitoringSummary: monitoring?.summary,
      fixture: { turns: 160, callsPerTurn: 3, cards: 480 },
      interactions: {
        chatEntry: true,
        scrollCycles: iterations,
        cardExpansionCycles: iterations,
        tabSwitchCycles: iterations,
        composerTypingCycles: iterations,
      },
      memory: {
        beforeWorkingSetMb: before.workingSetMb,
        afterWorkingSetMb: after.workingSetMb,
        workingSetGrowthMb,
        processCount: after.processCount,
      },
      dom: {
        beforeNodes: beforeDomNodes,
        afterNodes: afterDomNodes,
        nodeGrowth: domNodeGrowth,
      },
      cpuPercentAtCompletion: after.cpuPercent,
    };
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`release-like MCP evidence: ${JSON.stringify(evidence)}`);
    expect(workingSetGrowthMb).toBeLessThan(200);
    expect(domNodeGrowth).toBeLessThan(500);
    expect(after.processCount).toBe(before.processCount);
  } finally {
    await monitor?.stop();
    if (launched) {
      await closeCanopy(launched.electronApp, userDataDir);
    } else {
      for (const target of [userDataDir, `${userDataDir}-secure`]) {
        rmSync(target, { recursive: true, force: true });
      }
    }
  }
});
