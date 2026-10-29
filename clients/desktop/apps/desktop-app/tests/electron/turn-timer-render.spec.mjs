import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// ---------------------------------------------------------------------------
// Spec 3 (Doc 2) — turn-timer rendering: PRs 763/764/813/817.
//
// Seeds a STANDALONE chat transcript (cheapest path: renders via
// `ChatContent` → `ChatMessageList` → `TurnGroupRenderer` →
// desktop `TurnTimer` → shared `TurnTimer`) containing `turn_timer` blocks
// in paused / completed-short / completed-≥1h / boundary / pause-deducted states,
// then asserts the shared `TurnTimer`
// (`packages/ui-shared/src/components/TurnTimer.tsx`) renders the right visible
// label + `data-state` (H8).
//
// Rendering model (verified against the renderer): a turn group is
// `user message → assistant message(s) → system message whose single block is
// a turn_timer`. `groupIntoTurns` (turn-utils.ts) attaches that system message
// as `group.timerMessage`, and `TurnGroupRenderer` renders exactly one
// `TurnTimer` per group from it. So each seeded timer state is its own turn
// group (user + assistant + system-turn_timer triple).
//
// Label format comes from `formatElapsed` in TurnTimer.tsx:
//   < 1h  → `${minutes}:${ss}`            e.g. 95s → "1:35", 90s → "1:30"
//   ≥ 1h  → `${hours}:${mm}:${ss}`        e.g. 3661s → "1:01:01"
// elapsed seconds = floor((finishedAt|pausedAt − startedAt − pauseMs) / 1000).
// Wrapper labels: paused → `Paused at <fmt>`, completed → `Completed in <fmt>`.
//
// IMPORTANT — open-timer auto-completion: on load,
// `completePersistedTurnTimers` (chat-tabs.ts) force-completes any turn_timer
// with `completedAt === null && pausedAt == null` (a "live" timer). Paused
// timers (pausedAt set, completedAt null) and completed timers are preserved
// untouched. This spec therefore only seeds paused + completed timers so the
// on-disk state is exactly what renders.
// ---------------------------------------------------------------------------

const T = Date.parse('2026-04-10T12:00:00.000Z');

// Each entry: a turn group keyed by `order`, with the timer block shape and the
// expected rendered label + data-state.
const TIMER_CASES = [
  {
    order: 1,
    label: 'paused-1m35s',
    // PR 763/764 — paused render stays stopped, no spinner.
    block: {
      type: 'turn_timer',
      startedAt: T,
      pausedAt: T + 95_000,
      completedAt: null,
    },
    expectedState: 'paused',
    expectedLabel: 'Paused at 1:35',
  },
  {
    order: 2,
    label: 'completed-1m30s',
    // PR 813 — completed (not live) label.
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 90_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:30',
  },
  {
    order: 3,
    label: 'completed-1h01m01s',
    // PR 817 — H:MM:SS formatting at ≥ 1h.
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 3_661_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:01:01',
  },
  {
    order: 4,
    label: 'completed-1h00m00s-boundary',
    // PR 817 — exact 1h boundary → H:MM:SS.
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 3_600_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:00:00',
  },
  {
    order: 5,
    label: 'completed-59m59s-boundary',
    // PR 817 — just under 1h → M:SS (no hours segment).
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 3_599_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 59:59',
  },
  {
    order: 6,
    label: 'completed-resumed-pause-deducted',
    // A resumed timer deducts the completed pause window before rendering.
    block: {
      type: 'turn_timer',
      startedAt: T,
      pausedAt: T + 30_000,
      resumedAt: T + 90_000,
      completedAt: T + 150_000,
    },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:30',
  },
  {
    order: 7,
    label: 'failed',
    outcome: 'failed',
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 90_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:30',
  },
  {
    order: 8,
    label: 'cancelled',
    outcome: 'cancelled',
    block: { type: 'turn_timer', startedAt: T, completedAt: T + 90_000 },
    expectedState: 'completed',
    expectedLabel: 'Completed in 1:30',
  },
  {
    order: 9,
    label: 'completed-accumulated-pauses-deducted',
    // Repeated pauses are persisted as an accumulated total and deducted.
    block: {
      type: 'turn_timer',
      startedAt: T,
      pausedAt: T + 120_000,
      resumedAt: T + 150_000,
      accumulatedPausedDurationMs: 75_000,
      completedAt: T + 210_000,
    },
    expectedState: 'completed',
    expectedLabel: 'Completed in 2:15',
  },
];

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

// Build the `user → assistant → system-turn_timer` message triple for one
// turn group. Timestamps are spaced so groupIntoTurns keeps deterministic
// ordering and the assistant text never matches the user text within 1s (which
// would trip `isLikelyClaudeQueueEcho` and drop the assistant message).
function buildTurnGroupMessages(turnCase) {
  const base = T + turnCase.order * 60_000;
  return [
    {
      id: `turn-${turnCase.order}-user`,
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: `Request ${turnCase.order} (${turnCase.label}).`,
        },
      ],
      timestamp: base,
    },
    {
      id: `turn-${turnCase.order}-assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `Reply for turn ${turnCase.order}.` }],
      timestamp: base + 5_000,
    },
    {
      id: `turn-${turnCase.order}-timer`,
      role: 'system',
      blocks: [turnCase.block],
      timestamp: base + 6_000,
    },
  ];
}

function seedStandaloneTimerChat(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-04-10T12:00:00.000Z';

  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [
      {
        id: 'default',
        name: 'Default',
        createdAt,
        color: '#7C9B6D',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });

  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    id: 'default',
    name: 'Default',
    createdAt,
    color: '#7C9B6D',
    description: 'Turn-timer rendering fixture',
    defaultModel: 'gpt-6-luna',
  });

  writeText(
    path.join(projectDir, 'CLAUDE.md'),
    'Turn-timer rendering fixture instructions.\n',
  );

  const messages = TIMER_CASES.flatMap(buildTurnGroupMessages);

  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-timers',
    tabs: [
      {
        id: 'chat-timers',
        title: 'Turn Timer Chat',
        description: 'Turn-timer render coverage',
        createdAt,
        providerType: 'codex',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        turnEnds: Object.fromEntries(
          TIMER_CASES.filter((entry) => entry.outcome).map((entry) => [
            `turn-${entry.order}-user`,
            { outcome: entry.outcome, endedAt: entry.block.completedAt },
          ]),
        ),
        messages,
      },
    ],
  });
}

async function launchSeededTimerCanopy() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-turn-timer-'));
  seedStandaloneTimerChat(userDataDir);

  try {
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

test('renders seeded turn-timer blocks with the right label and data-state', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } = await launchSeededTimerCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openChatPage();

    // The active chat ('chat-timers') auto-selects on the chat page, rendering
    // its transcript. Each turn group renders exactly one shared TurnTimer.
    const timers = window.locator('[data-testid="turn-timer"]');
    await expect(timers).toHaveCount(TIMER_CASES.length);

    // Assert each timer (transcript order matches seeded turn-group order) by
    // index: the rendered visible label and the `data-state` attribute.
    for (let i = 0; i < TIMER_CASES.length; i += 1) {
      const expectedCase = TIMER_CASES[i];
      const timer = timers.nth(i);
      await expect(
        timer,
        `timer #${i} (${expectedCase.label}) data-state`,
      ).toHaveAttribute('data-state', expectedCase.expectedState);
      // The elapsed label lives in its own sub-element since CAN-2301 added
      // the relative completion timestamp alongside it.
      await expect(
        timer.locator('[data-testid="turn-timer-label"]'),
        `timer #${i} (${expectedCase.label}) label`,
      ).toHaveText(expectedCase.expectedLabel);

      // CAN-2301 — completed timers carry a completion stamp ("just now" /
      // "5m ago" while recent, then locale clock time such as "10:11 AM" or
      // "Apr 10, 9:15 AM"); paused timers must not. The seeded timers all
      // completed on a fixed past date, so they render the month-day tier —
      // assert the locale-agnostic invariant: a clock time is present.
      const relative = timer.locator('[data-testid="turn-timer-relative"]');
      if (expectedCase.expectedState === 'completed') {
        await expect(
          relative,
          `timer #${i} (${expectedCase.label}) completion stamp`,
        ).toHaveText(/\d{1,2}:\d{2}/);
      } else {
        await expect(
          relative,
          `timer #${i} (${expectedCase.label}) has no relative timestamp`,
        ).toHaveCount(0);
      }
    }

    // CAN-4278 — on every completed row, the LAST turn's included, the
    // timestamp stays visible while the "Completed in" label and actions are
    // transparent at rest and revealed only while their own turn is hovered.
    // `toBeVisible()` passes for `opacity: 0`, so assert computed opacity.
    const partOpacity = (index, testId) =>
      timers
        .nth(index)
        .locator(`[data-testid="${testId}"]`)
        .evaluate((el) => getComputedStyle(el).opacity);
    const rowOpacity = (index) => partOpacity(index, 'turn-timer-label');
    const lastIndex = TIMER_CASES.length - 1;
    const earlierCompletedIndex = TIMER_CASES.findIndex(
      (c) => c.expectedState === 'completed',
    );
    const pausedRowIndex = TIMER_CASES.findIndex(
      (c) => c.expectedState === 'paused',
    );
    expect(TIMER_CASES[lastIndex].expectedState).toBe('completed');
    expect(earlierCompletedIndex).toBeLessThan(lastIndex);
    await window.mouse.move(5, 5);
    await expect.poll(() => rowOpacity(lastIndex)).toBe('0');
    await expect.poll(() => rowOpacity(earlierCompletedIndex)).toBe('0');
    await expect.poll(() => rowOpacity(pausedRowIndex)).toBe('1');
    for (let index = 0; index < TIMER_CASES.length; index += 1) {
      if (TIMER_CASES[index].outcome) {
        await expect.poll(() => rowOpacity(index)).toBe('1');
      }
    }
    await expect(
      timers.nth(lastIndex).locator('[data-testid="turn-timer-relative"]'),
    ).not.toHaveClass(/opacity-0/);

    // CAN-4278 — a 20px gap separates the footer from the next user bubble,
    // the same gap the shared web transcript asserts. Measured against the
    // bubble, since a hoisted sticky prompt also carries the turn attribute:
    // the bubble is the first match after the footer in document order.
    const footerGap = await timers.nth(lastIndex - 1).evaluate(
      (timer, text) => {
        const leaf = [...document.querySelectorAll('body *')].find(
          (el) =>
            el.childElementCount === 0 &&
            (el.textContent ?? '').startsWith(text) &&
            (timer.compareDocumentPosition(el) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0,
        );
        let bubble = leaf ?? null;
        while (
          bubble &&
          getComputedStyle(bubble).backgroundColor === 'rgba(0, 0, 0, 0)'
        )
          bubble = bubble.parentElement;
        if (!bubble) return null;
        return Math.round(
          bubble.getBoundingClientRect().top -
            timer.getBoundingClientRect().bottom,
        );
      },
      `Request ${lastIndex + 1} (`,
    );
    expect(footerGap, 'gap from the footer to the next bubble').toBe(20);
    for (const index of [lastIndex, earlierCompletedIndex]) {
      await expect
        .poll(() => partOpacity(index, 'turn-timer-relative'))
        .toBe('1');
      await expect
        .poll(() =>
          timers.nth(index).evaluate((el) => getComputedStyle(el).opacity),
        )
        .toBe('1');
    }

    const lastBoxAtRest = await timers.nth(lastIndex).boundingBox();
    await timers.nth(lastIndex).hover();
    await expect.poll(() => rowOpacity(lastIndex)).toBe('1');
    // Hovering one turn never reveals another turn's footer, and revealing
    // the row does not move it.
    await expect.poll(() => rowOpacity(earlierCompletedIndex)).toBe('0');
    expect(await timers.nth(lastIndex).boundingBox()).toEqual(lastBoxAtRest);
    await window.mouse.move(5, 5);
    await expect.poll(() => rowOpacity(lastIndex)).toBe('0');

    // CAN-2301 — the completion stamp carries the full timestamp as a native
    // title (browser-rendered hover), with no custom tooltip element.
    const firstCompletedIndex = TIMER_CASES.findIndex(
      (c) => c.expectedState === 'completed',
    );
    await expect(
      timers
        .nth(firstCompletedIndex)
        .locator('[data-testid="turn-timer-relative"]'),
    ).toHaveAttribute('title', /^Completed at .+/);
    await expect(
      window.locator('[data-testid="turn-timer-completed-at-tooltip"]'),
    ).toHaveCount(0);

    // PR 763/764 — the paused timer must not contain a spinner and must not
    // tick. The shared component only renders the spinner while `live`, and a
    // paused timer is never live. Capture the paused label, wait past one tick
    // interval (~1s), and re-assert it is byte-for-byte unchanged.
    const pausedCase = TIMER_CASES.find((c) => c.expectedState === 'paused');
    const pausedIndex = TIMER_CASES.indexOf(pausedCase);
    const pausedTimer = timers.nth(pausedIndex);
    // A spinner (ThinkingSpinner) renders an animated SVG; assert none present.
    await expect(pausedTimer.locator('svg')).toHaveCount(0);
    const beforeText = await pausedTimer.textContent();
    await window.waitForTimeout(2_000);
    const afterText = await pausedTimer.textContent();
    expect(afterText).toBe(beforeText);
    expect(afterText).toBe(pausedCase.expectedLabel);

    // In a narrow side panel at the maximum shipped UI scale, neither
    // half of the completion metadata may wrap inside its own phrase. The
    // elapsed label and absolute completion stamp remain one line each even
    // while the always-mounted feedback controls stay beside the stamp.
    await window.setViewportSize({ width: 646, height: 720 });
    await setUiScale(window, 150);
    const narrowCompletedTimer = timers.nth(TIMER_CASES.length - 1);
    const narrowLineCounts = await narrowCompletedTimer.evaluate((timer) => {
      const lineCount = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const lineHeight = Number.parseFloat(
          getComputedStyle(element).lineHeight,
        );
        return Math.round(element.getBoundingClientRect().height / lineHeight);
      };
      return {
        elapsed: lineCount(
          timer.querySelector('[data-testid="turn-timer-label"]'),
        ),
        completedAt: lineCount(
          timer.querySelector('[data-testid="turn-timer-relative"]'),
        ),
      };
    });
    expect(narrowLineCounts).toEqual({
      elapsed: 1,
      completedAt: 1,
    });

    await window.screenshot({
      path: testInfo.outputPath('turn-timer-render.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});

test('foreground continuation restarts the timer but late child traffic does not', async () => {
  const { launchAuthRecoveryFixture, AUTH_RECOVERY_SCOPE } =
    await import('./authRecoveryFixture.mjs');
  const { injectChatEvent } = await import('./seeders/index.mjs');
  const fixture = await launchAuthRecoveryFixture({ worked: true });
  const timer = fixture.panel.getByTestId('turn-timer');
  const ingest = (data) =>
    injectChatEvent(fixture.electronApp, {
      ...AUTH_RECOVERY_SCOPE,
      providerType: 'claude',
      turnUserMessageId: 'original-user',
      data,
    });
  try {
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await ingest({
      type: 'assistant',
      parent_tool_use_id: 'background-child',
      uuid: 'child-update',
      message: { content: [{ type: 'text', text: 'Background update' }] },
    });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await ingest({
      type: 'assistant',
      uuid: 'foreground-update',
      message: {
        content: [{ type: 'text', text: 'Continuing the investigation' }],
      },
    });
    await expect(timer).toHaveAttribute('data-state', 'live');
    await ingest({ type: 'result', subtype: 'success', result: 'Finished' });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await ingest({
      type: 'assistant',
      uuid: 'foreground-update',
      message: {
        content: [{ type: 'text', text: 'Continuing the investigation' }],
      },
    });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await ingest({
      type: 'assistant',
      uuid: 'late-auth-error',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Connection expired' }] },
    });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await ingest({ type: 'system', subtype: 'status' });
    await expect(timer).toHaveAttribute('data-state', 'completed');
    await fixture.app.openChatPage();
    await fixture.app.openMainPage();
    await expect(timer).toHaveAttribute('data-state', 'completed');
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});
