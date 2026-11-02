import { seedCursorAudit } from './fixtures/cursor-audit.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedUsageEvents, writeJson, writeJsonl } from './seeders/index.mjs';
import { seedCodexSpeedAudit } from './seeders/seedCodexSpeedAudit.mjs';
import {
  installExactFileIoCounter,
  readExactFileIoCounter,
  stopExactFileIoCounter,
} from './seeders/exactFileIoCounter.mjs';

function exactCounterDelta(after, before) {
  return {
    paths: Object.fromEntries(
      Object.entries(after.paths).map(([filePath, counters]) => [
        filePath,
        Object.fromEntries(
          Object.entries(counters).map(([key, value]) => [
            key,
            value - before.paths[filePath][key],
          ]),
        ),
      ]),
    ),
    snapshotStringify: Object.fromEntries(
      Object.entries(after.snapshotStringify).map(([key, value]) => [
        key,
        value - before.snapshotStringify[key],
      ]),
    ),
    processCpuMicroseconds: Object.fromEntries(
      Object.entries(after.processCpuMicroseconds).map(([key, value]) => [
        key,
        value - before.processCpuMicroseconds[key],
      ]),
    ),
    processWallNanoseconds:
      after.processWallNanoseconds - before.processWallNanoseconds,
  };
}

function createToolCounts(overrides = {}) {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    writeEdit: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    appAdvisor: 0,
    mcp: 0,
    other: 0,
    ...overrides,
  };
}

function createAuditEntry(overrides) {
  return {
    id: overrides.id,
    eventType: overrides.eventType,
    status: overrides.status,
    provider: overrides.provider,
    label: overrides.label,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    durationMs: 12_000,
    model: overrides.model,
    totalCostUsd: overrides.totalCostUsd,
    observedCost: overrides.observedCost,
    tokens: overrides.tokens,
    messageCount: overrides.messageCount,
    assistantMessageCount: overrides.assistantMessageCount,
    toolUseCount: overrides.toolUseCount,
    subAgentCount: 0,
    toolCounts: overrides.toolCounts,
    error: overrides.error,
    projectId: overrides.projectId,
    worktreeId: overrides.worktreeId,
    repoId: overrides.repoId,
    repoLabel: overrides.repoLabel,
    chatId: overrides.chatId,
    sdkSessionId: overrides.sdkSessionId,
    hasTranscript: overrides.hasTranscript,
    linkTarget: overrides.linkTarget,
  };
}

function sanitizeTranscriptKeySegment(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'na';
}

function buildTranscriptFilePath(userDataDir, entry) {
  const startedAt = entry.startedAt;
  const eventType = entry.eventType;
  const day = startedAt.slice(0, 10);
  const digest = createHash('sha256')
    .update([eventType, startedAt, entry.id].join('\n'))
    .digest('hex')
    .slice(0, 12);
  const storageKey = [
    sanitizeTranscriptKeySegment(eventType),
    sanitizeTranscriptKeySegment(startedAt),
    digest,
  ].join('__');
  return path.join(
    userDataDir,
    'agent-observability',
    'transcripts',
    day,
    `${storageKey}.jsonl`,
  );
}

function seedObservabilityData(userDataDir) {
  const nowMs = Date.now();
  const codexStartedAt = new Date(nowMs - 10 * 60_000).toISOString();
  const claudeStartedAt = new Date(nowMs - 8 * 60_000).toISOString();

  const codexEntry = createAuditEntry({
    id: 'seeded-codex-turn',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'codex',
    label: 'Seeded Codex Chat Turn',
    startedAt: codexStartedAt,
    completedAt: new Date(nowMs - 9 * 60_000).toISOString(),
    model: 'gpt-6-luna',
    totalCostUsd: 0.0042,
    observedCost: {
      status: 'priced',
      reason: 'priced',
      totalUsd: 0.0042,
      tokenUsd: 0.0042,
      nonTokenUsd: 0,
      pricingBasis: 'openai_api_standard',
    },
    tokens: {
      input: 1200,
      output: 345,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 2,
    toolCounts: createToolCounts({ bash: 1, askUser: 1 }),
    projectId: 'workspace-seeded',
    worktreeId: 'worktree-seeded',
    repoId: 'repo-seeded',
    repoLabel: 'seeded-repo',
    chatId: 'chat-seeded',
    sdkSessionId: 'thread-seeded',
    hasTranscript: true,
    linkTarget: {
      page: 'main',
      kind: 'worktree-chat',
      projectId: 'workspace-seeded',
      worktreeId: 'worktree-seeded',
      chatId: 'chat-seeded',
    },
  });

  const claudeEntry = createAuditEntry({
    id: 'seeded-branch-failure',
    eventType: 'branch_naming',
    status: 'failure',
    provider: 'claude',
    label: 'Seeded Branch Name Failure',
    startedAt: claudeStartedAt,
    completedAt: new Date(nowMs - 7 * 60_000).toISOString(),
    model: 'claude-sonnet-4-6',
    totalCostUsd: 0.0042,
    tokens: {
      input: 700,
      output: 120,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 1,
    assistantMessageCount: 0,
    toolUseCount: 0,
    toolCounts: createToolCounts(),
    error: 'branch naming timed out',
    projectId: 'workspace-seeded',
    worktreeId: 'worktree-seeded',
    repoId: 'repo-seeded',
    repoLabel: 'seeded-repo',
    hasTranscript: false,
  });

  const memoryStartedAt = new Date(nowMs - 6 * 60_000).toISOString();
  const memoryEntry = createAuditEntry({
    id: 'seeded-memory-consolidation',
    eventType: 'local_memory_consolidation',
    status: 'success',
    provider: 'claude',
    label: 'Memory Consolidation',
    startedAt: memoryStartedAt,
    completedAt: new Date(nowMs - 5 * 60_000).toISOString(),
    model: 'claude-haiku-4-5-20251001',
    totalCostUsd: 0.0007,
    tokens: {
      input: 400,
      output: 90,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 0,
    toolCounts: createToolCounts(),
    hasTranscript: false,
  });

  const day = codexStartedAt.slice(0, 10);
  writeJsonl(
    path.join(userDataDir, 'agent-observability', 'audit', `${day}.jsonl`),
    [codexEntry, claudeEntry, memoryEntry],
  );
  writeJson(path.join(userDataDir, 'agent-observability', 'snapshot.json'), {
    version: 1,
    historicalMode: 'forward-only',
    retentionDays: 7,
    recentEntries: [codexEntry, claudeEntry, memoryEntry],
    usage: {
      updatedAt: new Date(nowMs).toISOString(),
      providers: [],
    },
  });
  seedUsageEvents({
    userDataDir,
    events: [
      {
        version: 1,
        id: 'seeded-codex-turn-usage',
        type: 'chat_turn_completed',
        timestamp: codexEntry.completedAt,
        workspaceId: codexEntry.projectId,
        workspaceLabel: 'Seeded Project',
        worktreeId: codexEntry.worktreeId,
        repoId: codexEntry.repoId,
        repoLabel: codexEntry.repoLabel,
        provider: codexEntry.provider,
        initiationSource: 'user',
        chatId: codexEntry.chatId,
        auditEntryId: codexEntry.id,
        model: codexEntry.model,
        turnStartedAt: codexEntry.startedAt,
        turnCompletedAt: codexEntry.completedAt,
        turnDurationMs: codexEntry.durationMs,
        turnIndexInChat: 0,
        turnIndexInWorktree: 0,
        tokens: codexEntry.tokens,
        toolUseCount: codexEntry.toolUseCount,
        totalCostUsd: 0.0042,
        status: codexEntry.status,
      },
    ],
  });
  writeJsonl(buildTranscriptFilePath(userDataDir, codexEntry), [
    {
      type: 'canopy_injected_prompt',
      kind: 'system_prompt_append',
      provider: 'codex',
      application_condition: 'codex_first_turn_without_session_id',
      text: 'Seeded system prompt append',
    },
    {
      type: 'canopy_user_prompt',
      provider: 'codex',
      original_text: 'seeded transcript user prompt',
      submitted_text: 'seeded transcript user prompt',
      plan_mode: false,
    },
    {
      type: 'response_item',
      role: 'assistant',
      content: 'seeded transcript assistant output',
    },
  ]);
}

async function launchSeededObservabilityCanopy() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-observability-'),
  );
  seedObservabilityData(userDataDir);

  try {
    const launched = await launchCanopy({ userDataDir });
    return {
      ...launched,
      seededUserDataDir: userDataDir,
    };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

test('Ultra fast audit details distinguish requested speed from served tier and dollar cost', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'codex-speed-audit-'));
  const entryId = seedCodexSpeedAudit(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAuditPage();
    await window.getByTestId(`audit-transcript-button-${entryId}`).click();
    const details = window.getByTestId('audit-transcript-modal');
    await expect(details).toBeVisible();
    await expect(details).toContainText('Requested Ultra fast');
    await expect(details).toContainText('Actual tier unreported');
    await expect(details).toContainText(
      'Cost unavailable: pricing data has no rates for Ultra fast.',
    );
    await expect(details).not.toContainText('$0');
    // The unavailable-cost explanation wraps at word boundaries in its column.
    const cost = details.getByText(
      'Cost unavailable: pricing data has no rates for Ultra fast.',
      { exact: true },
    );
    expect(
      await cost.evaluate((element) => {
        const text = element.firstChild;
        if (!(text instanceof Text)) throw new Error('Cost text unavailable');
        const start = text.data.indexOf('for Ultra fast');
        if (start < 0) throw new Error('Cost explanation unavailable');
        const word = document.createRange();
        word.setStart(text, start);
        word.setEnd(text, start + 3);
        return word.getClientRects().length;
      }),
    ).toBe(1);
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click();
    await app.openStatisticsPage();
    await window.getByTestId('statistics-tab-cost').click();
    await window
      .getByRole('button', { name: 'Codex cost is an estimate', exact: true })
      .click();
    await expect(window.getByTestId('usage-metrics-tab-cost')).toContainText(
      "They don't measure subscription allowance",
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('loads persisted audit entries, transcripts, filters, and usage', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } =
    await launchSeededObservabilityCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openAuditPage();

    const codexEntry = window
      .getByTestId('audit-cost-seeded-codex-turn')
      .locator(
        'xpath=ancestor::div[.//*[@data-testid="audit-transcript-button-seeded-codex-turn"]][1]',
      );
    const codexEntryLabel = codexEntry.locator('span').filter({
      hasText: /^Code chat$/,
    });

    await expect(codexEntryLabel).toBeVisible();
    await expect(window.getByText('Seeded Branch Name Failure')).toBeVisible();
    await expect(window.getByText('branch naming timed out')).toBeVisible();
    await expect(window.getByTestId('audit-cost-seeded-codex-turn')).toHaveText(
      '$0.0042',
    );

    // The page search row: the search, then Provider, Status and Event as
    // quiet dropdowns after it.
    const auditSearch = window.getByTestId('audit-trail-search');
    await expect(auditSearch).toHaveAttribute(
      'placeholder',
      'Search the audit trail',
    );
    await auditSearch.fill('Branch Name');
    await expect(window.getByText('Seeded Branch Name Failure')).toBeVisible();
    await expect(codexEntryLabel).toBeHidden();

    await auditSearch.fill('');
    await expect(
      window.getByTestId('page-audit').locator('select'),
    ).toHaveCount(0);
    await app.chooseAuditTrailFilter('provider', 'codex');
    await app.chooseAuditTrailFilter('status', 'success');
    await app.chooseAuditTrailFilter('event-type', 'worktree_chat');
    await expect(window.getByTestId('audit-trail-provider-filter')).toHaveText(
      'Codex',
    );
    await expect(codexEntryLabel).toBeVisible();
    await expect(window.getByText('Seeded Branch Name Failure')).toBeHidden();

    await app.chooseAuditTrailFilter('provider', 'all');
    await app.chooseAuditTrailFilter('status', 'all');
    await app.chooseAuditTrailFilter(
      'event-type',
      'local_memory_consolidation',
    );
    await expect(
      window.getByTestId('audit-cost-seeded-memory-consolidation'),
    ).toHaveText('$0.0007');
    await expect(codexEntryLabel).toBeHidden();
    await expect(window.getByText('Seeded Branch Name Failure')).toBeHidden();

    await app.chooseAuditTrailFilter('event-type', 'all');
    await expect(codexEntryLabel).toBeVisible();

    await window
      .getByTestId('audit-transcript-button-seeded-codex-turn')
      .click();
    await expect(window.getByTestId('audit-transcript-modal')).toBeVisible();
    await expect(
      window.getByTestId('audit-transcript-injected-prompts'),
    ).toContainText('Seeded system prompt append');
    await window.getByTestId('audit-transcript-mode-raw').click();
    await expect(window.getByTestId('audit-transcript-raw')).toContainText(
      'seeded transcript user prompt',
    );
    await expect(window.getByTestId('audit-transcript-raw')).toContainText(
      'seeded transcript assistant output',
    );
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(window.getByTestId('audit-transcript-modal')).toBeHidden();

    await app.openStatisticsPage();
    await window.getByTestId('statistics-tab-chats').click();
    const chatMetrics = window.getByTestId('usage-metrics-tab-chats');
    await expect(chatMetrics).toContainText('Total turns');
    await expect(
      window.getByTestId('usage-headline-card-total_turns-value'),
    ).toHaveText('1');
    await expect(chatMetrics).toContainText('Tool calls');
    await expect(
      window.getByTestId('usage-headline-card-tool_calls-value'),
    ).toHaveText('2');

    await window.getByTestId('statistics-tab-cost').click();
    const costMetrics = window.getByTestId('usage-metrics-tab-cost');
    await expect(costMetrics).toContainText('$0.0042');

    await window.getByTestId('statistics-tab-tokens').click();
    const tokenMetrics = window.getByTestId('usage-metrics-tab-tokens');
    await expect(tokenMetrics).toContainText('1,200');
    await expect(tokenMetrics).toContainText('345');

    await window.screenshot({
      path: testInfo.outputPath('observability-validation.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

test('persists a diagnostic-only flush without losing audit and usage state', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { electronApp, seededUserDataDir } =
    await launchSeededObservabilityCanopy();
  let activeApp = electronApp;
  let ioCounterInstalled = false;
  const diagnosticReason = 'E2E diagnostic-only persistence probe';
  const snapshotPath = path.join(
    seededUserDataDir,
    'agent-observability',
    'snapshot.json',
  );
  const diagnosticPath = path.join(
    seededUserDataDir,
    'agent-observability',
    'diagnostics',
    'app-events',
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  const measureIo = process.env.CANOPY_ADJACENT_IO_MEASURE === '1';

  try {
    const window = await activeApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const before = await window.evaluate(() =>
      window.api.observability.loadSnapshot(),
    );
    expect(before.recentEntries.map((entry) => entry.id)).toContain(
      'seeded-codex-turn',
    );
    const recordDiagnostic = (reason) =>
      window.evaluate(
        (value) =>
          window.api.observability.recordDesktopInstrumentationInitFailure({
            surface: 'main',
            reason: value,
          }),
        reason,
      );
    const waitForDiagnostic = (reason) =>
      expect
        .poll(() => {
          try {
            return readFileSync(diagnosticPath, 'utf8');
          } catch {
            return '';
          }
        })
        .toContain(reason);
    const waitForFlush = async () => {
      // The app-event append precedes the optional snapshot write. Give the
      // same bounded post-append interval to baseline and candidate, then
      // require an idle tracked I/O window before reading counters. This also
      // works if the candidate skips snapshot serialization altogether.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect
        .poll(async () => {
          const first = await readExactFileIoCounter(activeApp);
          if (
            first.activeTrackedOperations !== 0 ||
            first.activeTrackedHandles !== 0
          ) {
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          const second = await readExactFileIoCounter(activeApp);
          return (
            second.activeTrackedOperations === 0 &&
            second.activeTrackedHandles === 0 &&
            JSON.stringify(first.paths) === JSON.stringify(second.paths) &&
            first.snapshotStringify.calls === second.snapshotStringify.calls
          );
        })
        .toBe(true);
    };
    if (measureIo) {
      // Warm the initial snapshot write, then discard its counters. The
      // measured requests are diagnostic-only flushes over unchanged state.
      await installExactFileIoCounter(activeApp, [
        snapshotPath,
        diagnosticPath,
      ]);
      ioCounterInstalled = true;
      await recordDiagnostic(`${diagnosticReason}: warmup`);
      await waitForDiagnostic(`${diagnosticReason}: warmup`);
      await waitForFlush();
      await stopExactFileIoCounter(activeApp);
      ioCounterInstalled = false;
      await installExactFileIoCounter(activeApp, [
        snapshotPath,
        diagnosticPath,
      ]);
      ioCounterInstalled = true;
    }

    const flushCount = measureIo ? 5 : 1;
    for (let index = 0; index < flushCount; index += 1) {
      const reason = `${diagnosticReason}: ${index}`;
      await recordDiagnostic(reason);
      await waitForDiagnostic(reason);
      if (measureIo) await waitForFlush();
    }

    if (ioCounterInstalled) {
      const unchanged = await readExactFileIoCounter(activeApp);
      // A real public preference save changes snapshot content and schedules
      // the same writer. Measure it separately so the unchanged-snapshot
      // optimization cannot hide extra serialization on actual changes.
      await window.evaluate(() =>
        window.api.savePreferences({ auditRetentionDays: 8 }),
      );
      await expect
        .poll(() => {
          try {
            return JSON.parse(readFileSync(snapshotPath, 'utf8')).retentionDays;
          } catch {
            return null;
          }
        })
        .toBe(8);
      await waitForFlush();
      const totals = await stopExactFileIoCounter(activeApp);
      ioCounterInstalled = false;
      const changed = exactCounterDelta(totals, unchanged);
      expect(unchanged.paths[diagnosticPath].writeBytes).toBeGreaterThan(0);
      expect(unchanged.paths[snapshotPath].writeBytes).toBe(0);
      expect(unchanged.paths[snapshotPath].renameCalls).toBe(0);
      expect(changed.paths[snapshotPath].writeBytes).toBeGreaterThan(0);
      expect(changed.paths[snapshotPath].renameCalls).toBeGreaterThan(0);
      expect(changed.snapshotStringify.calls).toBeGreaterThan(0);
      const counts = {
        unchangedDiagnostic: unchanged,
        changedSnapshot: changed,
        totals,
      };
      await testInfo.attach('observability-diagnostic-io', {
        body: JSON.stringify(counts, null, 2),
        contentType: 'application/json',
      });
    }

    const persisted = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(persisted.recentEntries.map((entry) => entry.id)).toContain(
      'seeded-codex-turn',
    );
    await closeCanopy(activeApp, seededUserDataDir, { keepUserData: true });
    activeApp = null;

    const restarted = await launchCanopy({ userDataDir: seededUserDataDir });
    activeApp = restarted.electronApp;
    const restoredWindow = await activeApp.firstWindow();
    const restoredApp = new CanopyAppDriver(restoredWindow);
    await restoredApp.waitForShell();
    const restored = await restoredWindow.evaluate(() =>
      window.api.observability.loadSnapshot(),
    );
    expect(restored.recentEntries.map((entry) => entry.id)).toContain(
      'seeded-codex-turn',
    );
    await restoredApp.openStatisticsPage();
    await restoredWindow.getByTestId('statistics-tab-chats').click();
    await expect(
      restoredWindow.getByTestId('usage-headline-card-total_turns-value'),
    ).toHaveText('1');
  } finally {
    if (ioCounterInstalled && activeApp) {
      await stopExactFileIoCounter(activeApp);
    }
    if (activeApp) {
      await closeCanopy(activeApp, seededUserDataDir);
    } else {
      rmSync(seededUserDataDir, { recursive: true, force: true });
    }
  }
});

test('persists continuous app diagnostics while the Statistics page remains open', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { electronApp, seededUserDataDir } =
    await launchSeededObservabilityCanopy();
  const dayFile = path.join(
    seededUserDataDir,
    'agent-observability',
    'diagnostics',
    'app-events',
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  const marker = `continuous-diagnostic-${Date.now()}`;
  let producer;
  let producerFinished = false;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openStatisticsPage();
    await expect(window.getByTestId('statistics-tab-chats')).toBeVisible();

    // The real renderer IPC producer keeps enqueueing diagnostics faster than
    // the trailing debounce. An older record must persist before it stops.
    producer = window.evaluate(async (prefix) => {
      const timestamps = [];
      for (let index = 0; index < 30; index += 1) {
        timestamps.push(Date.now());
        await window.api.observability.recordDesktopInstrumentationInitFailure({
          surface: 'main',
          reason: `${prefix}:${index}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { timestamps, completedAt: Date.now() };
    }, marker);
    void producer.then(
      () => {
        producerFinished = true;
      },
      () => {
        producerFinished = true;
      },
    );
    let firstPersistedAt = null;
    let earlyError = null;
    let producerFinishedAtAssertion = null;
    try {
      await expect
        .poll(
          () => {
            try {
              return readFileSync(dayFile, 'utf8');
            } catch {
              return '';
            }
          },
          { timeout: 2_500, intervals: [50, 100] },
        )
        .toContain(`${marker}:0`);
      firstPersistedAt = Date.now();
      producerFinishedAtAssertion = producerFinished;
      expect(producerFinished).toBe(false);
    } catch (error) {
      earlyError = error;
      producerFinishedAtAssertion = producerFinished;
    }
    const cadence = await producer;
    producer = null;
    const gapsMs = cadence.timestamps
      .slice(1)
      .map((timestamp, index) => timestamp - cadence.timestamps[index]);
    const maxProducerGapMs = Math.max(0, ...gapsMs);
    writeFileSync(
      testInfo.outputPath('continuous-diagnostics-producer.json'),
      `${JSON.stringify(
        {
          marker,
          timestamps: cadence.timestamps,
          completedAt: cadence.completedAt,
          firstPersistedAt,
          producerFinishedAtAssertion,
          maxProducerGapMs,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (maxProducerGapMs > 300) {
      throw new Error(
        `Inconclusive diagnostic cadence: producer gap ${maxProducerGapMs} ms exceeds 300 ms`,
      );
    }
    if (earlyError) throw earlyError;
    await expect
      .poll(() => {
        try {
          return readFileSync(dayFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((record) => record.reason?.startsWith(marker)).length;
        } catch {
          return 0;
        }
      })
      .toBe(30);
  } finally {
    if (producer) await producer.catch(() => undefined);
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

test('reloads persisted Cursor audit history in the Audit page', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-audit-reload-'),
  );
  seedCursorAudit(userDataDir);
  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openAuditPage();
    await window.getByPlaceholder('Search').fill('cursor-default');
    await expect(
      window.getByTestId('audit-duration-cursor-persisted'),
    ).toBeVisible();
    await window
      .getByTestId('audit-transcript-button-cursor-persisted')
      .click();
    await expect(
      window.getByTestId('audit-transcript-injected-prompts'),
    ).toContainText('Cursor organization release checklist.');
    await expect(
      window
        .getByTestId('audit-transcript-injected-prompts')
        .getByText('Organization memory', { exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await driver.openStatisticsPage();
    await window.getByTestId('statistics-tab-chats').click();
    await expect(
      window.getByTestId('usage-headline-card-total_turns-value'),
    ).toHaveText('1');
    const metrics = await window.evaluate(() =>
      window.api.observability.loadUsageMetrics({
        startDate: '2020-01-01T00:00:00Z',
        endDate: '2030-01-01T00:00:00Z',
        provider: 'cursor',
      }),
    );
    expect(metrics.chats.turnCountsByProvider.rows).toContainEqual(
      expect.objectContaining({ provider: 'cursor', count: 1 }),
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
