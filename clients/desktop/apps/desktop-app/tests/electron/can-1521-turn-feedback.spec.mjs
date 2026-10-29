import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedObservabilityAudit } from './seeders/seedObservabilityAudit.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// CAN-1521 — turn-level thumbs up/down feedback on completed assistant turns.
//
// Durable regression spec. Seeds three COMPLETED turn groups in a worktree chat
// and drives the real control through the Electron renderer:
//
//   (a) thumbs-up sets `data-rating="up"`; clicking the same thumb again
//       clears it back to `data-rating="none"` (the control passes `null` for
//       the already-selected rating).
//   (b) thumbs-down opens the detail dialog; pick a reason, type a comment,
//       submit — the dialog closes and the rating stays `down`.
//   (c) thumbs-down followed by Skip, and thumbs-down followed by Escape, both
//       leave `data-rating="down"` set. The Escape case then survives a full
//       app relaunch (the rating lives on `ChatTab.turnFeedback`, persisted by
//       `stores/chat/persisted-tabs.ts`).
//   (d) the control sits right after the completion stamp, ahead of the
//       "Completed in" label and any Fork / Branch / Share actions, on both
//       the LAST FORKABLE turn and an ordinary turn. That is `TurnTimer`'s
//       `stampAccessory` slot (`packages/ui-shared/src/components/TurnTimer.tsx`,
//       CAN-4278), so trailing actions never move it.
//   (e) the read-only `TranscriptViewer` renders ZERO controls. That surface
//       passes no `chatId`, and `chatId === undefined` is the entire read-only
//       gate in `TurnGroupRenderer`. The Audit Trail transcript modal is the
//       deterministically reachable `TranscriptViewer` consumer (see
//       `observability.spec.mjs`), so this seeds an audit entry with a
//       transcript sidecar and asserts a COMPLETED turn group renders there
//       with no feedback control — proving absence is the read-only gate and
//       not merely an incomplete turn.
//
// Selectors (all verified against source):
//   - `turn-feedback-control` wrapper carries `data-rating="none|up|down"` and
//     `data-sync-state` — `packages/ui-shared/src/components/TurnFeedbackControl.tsx`
//   - `turn-feedback-up` / `turn-feedback-down` buttons are ALWAYS mounted.
//     They sit right after the completion stamp and stay visible at rest,
//     rated or not (CAN-4278).
//   - `turn-feedback-dialog`, `turn-feedback-reason-<code>` (codes from
//     `TURN_FEEDBACK_REASONS` in `packages/protocol/src/turn-feedback/index.ts`),
//     `turn-feedback-comment`, `turn-feedback-skip`, `turn-feedback-submit` —
//     `packages/ui-shared/src/components/TurnFeedbackDialog.tsx`
//   - `data-chat-turn-group="<userMessageId>"` scopes each turn; it is set on
//     the existing per-turn wrapper in `ChatMessageList.tsx`.
//
// Seeding contract (mirrors `chat-transcript-actions.spec.mjs`): turn groups
// are spaced 120s apart and the assistant message lands 10s after the user
// message, with text that DIFFERS from the user text — otherwise
// `isLikelyClaudeQueueEcho` drops the assistant message and the turn stops
// being forkable.
//
// Determinism: no live agents, no network. Every rating round-trips through
// the real `turn-feedback:rate` IPC, which is fail-soft by construction — when
// Canopy Cloud is unreachable (always, here) the rating is queued locally and
// the handler still resolves, so nothing in this spec depends on the network.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'can-1521-feedback';
const CHAT_UNIT_LABEL = 'Chat';

const AUDIT_ENTRY_ID = 'can-1521-audit-turn';

const T = Date.parse('2026-04-10T12:00:00.000Z');

/**
 * `user → assistant → system(turn_timer completed)` triple for one turn group.
 * See the seeding contract note in the header comment for the 120s / 10s
 * spacing and the "assistant text must differ from user text" rule.
 */
function buildTurnGroup(order) {
  const base = T + order * 120_000;
  return [
    {
      id: `turn-${order}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Request number ${order}.` }],
      timestamp: base,
    },
    {
      id: `turn-${order}-assistant`,
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: `Completed the work for step ${order}.${order === 2 ? '\n\n[Footer reference](https://example.test/reference)' : ''}`,
        },
      ],
      timestamp: base + 10_000,
    },
    {
      id: `turn-${order}-timer`,
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: base, completedAt: base + 30_000 },
      ],
      timestamp: base + 20_000,
    },
  ];
}

function seedFeedbackChat(userDataDir) {
  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Turn Feedback',
        providerType: 'codex',
        model: 'gpt-6-sol',
        sharedRun: {
          externalId: '11111111-1111-4111-8111-111111111111',
          shareScope: 'team',
          sharedAt: '2026-04-10T12:00:00.000Z',
          commentRevision: 1,
          unreadCommentCount: 2,
        },
        messages: [
          ...buildTurnGroup(1),
          ...buildTurnGroup(2),
          ...buildTurnGroup(3),
        ],
      },
    ],
  });
}

/** Zeroed `AgentAuditToolCounts` (every field is required on the entry). */
function zeroToolCounts() {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

/**
 * One audit entry with a transcript sidecar, so the Audit Trail transcript
 * modal (the read-only `TranscriptViewer` host) is reachable. The `success`
 * status makes the modal pass `closeOpenTurnAtEnd`, so the parsed transcript's
 * open turn timer is completed and the turn group renders as COMPLETE.
 */
function seedAuditTranscript(userDataDir) {
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const completedAt = new Date(Date.now() - 9 * 60_000).toISOString();
  return seedObservabilityAudit({
    userDataDir,
    entries: [
      {
        id: AUDIT_ENTRY_ID,
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'codex',
        label: 'CAN-1521 Read-only Transcript',
        startedAt,
        completedAt,
        durationMs: 12_000,
        model: 'gpt-6-sol',
        totalCostUsd: 0.0042,
        tokens: {
          input: 1200,
          output: 345,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 2,
        assistantMessageCount: 1,
        toolUseCount: 0,
        subAgentCount: 0,
        toolCounts: zeroToolCounts(),
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        hasTranscript: true,
      },
    ],
    transcripts: {
      [AUDIT_ENTRY_ID]: [
        {
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'read-only transcript user prompt',
          submitted_text: 'read-only transcript user prompt',
          plan_mode: false,
        },
        // A real Codex `item.completed` / `agent_message` event — the shape the
        // transcript parser actually reduces into an assistant text block.
        // (`response_item` lines, as used by `observability.spec.mjs`, are
        // skipped by the parser and only ever show up in the RAW view.)
        {
          type: 'item.completed',
          thread_id: 'can-1521-thread',
          turn_id: 'can-1521-turn',
          item: {
            id: 'can-1521-agent-message',
            type: 'agent_message',
            text: 'read-only transcript assistant output',
          },
        },
      ],
    },
  });
}

/** Per-turn wrapper (`data-chat-turn-group` in `ChatMessageList.tsx`). */
function turnScope(window, order) {
  return window.locator(`[data-chat-turn-group="turn-${order}-user"]`);
}

function feedbackControl(window, order) {
  return turnScope(window, order).getByTestId('turn-feedback-control');
}

async function openWorktreeChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();
  // All three seeded turn groups must be mounted before anything is measured.
  await expect(
    window.locator('[data-testid="turn-feedback-control"]'),
  ).toHaveCount(3, { timeout: 20_000 });
  return { window, app };
}

test('records, clears, details, pins, and persists turn-level feedback', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can-1521-'),
  );
  try {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedFeedbackChat(userDataDir);
    seedAuditTranscript(userDataDir);
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }

  // ---- Launch 1 ---------------------------------------------------------
  const first = await launchCanopy({ userDataDir });
  try {
    const { window, app } = await openWorktreeChat(first.electronApp);

    // Every seeded turn starts unrated.
    for (const order of [1, 2, 3]) {
      await expect(feedbackControl(window, order)).toHaveAttribute(
        'data-rating',
        'none',
      );
    }

    // ---- (d) The control sits right after the stamp, whether or not the
    // turn also carries Fork / Branch / Share actions. Measured FIRST, before
    // any click, at rest.
    const forkableTurn = turnScope(window, 3);
    const ordinaryTurn = turnScope(window, 1);
    // CAN-4278: computed opacity, effective feedback, isolation and geometry.
    // The timestamp always shows; `footer` is the hover/focus-only label.
    const middleTurn = turnScope(window, 2);
    const footer = middleTurn.getByTestId('turn-timer-label');
    const opacity = (locator) =>
      locator.evaluate((el) => getComputedStyle(el).opacity);
    // Product of every ancestor's opacity: what the user actually sees.
    const effectiveOpacity = (locator) =>
      locator.evaluate((el) => {
        let value = 1;
        for (let node = el; node; node = node.parentElement)
          value *= Number(getComputedStyle(node).opacity);
        return Math.round(value * 100) / 100;
      });
    await window.mouse.move(5, 5);
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    for (const order of [1, 2, 3]) {
      await expect
        .poll(() =>
          opacity(turnScope(window, order).getByTestId('turn-timer-label')),
        )
        .toBe('0');
      await expect
        .poll(() =>
          opacity(turnScope(window, order).getByTestId('turn-timer-relative')),
        )
        .toBe('1');
      // CAN-4278: the thumbs stay visible at rest beside the stamp.
      await expect
        .poll(() => effectiveOpacity(feedbackControl(window, order)))
        .toBe(1);
    }
    await footer.scrollIntoViewIfNeeded();
    const plainThumb = middleTurn.getByTestId('turn-feedback-up');
    await expect(plainThumb).toHaveAccessibleName('Good response');
    await expect(plainThumb).toHaveCSS('border-top-width', '0px');
    const restingBackground = await plainThumb.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await plainThumb.hover();
    await expect
      .poll(() =>
        plainThumb.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .not.toBe(restingBackground);
    await window.mouse.move(5, 5);
    await expect(plainThumb).toHaveCSS('background-color', restingBackground);
    // Touch keeps the same shared controls visible with real 44px targets.
    const cdp = await window.context().newCDPSession(window);
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 1,
      });
      expect(
        await window.evaluate(() => matchMedia('(pointer: coarse)').matches),
      ).toBe(true);
      for (const testId of ['turn-feedback-up', 'turn-feedback-down']) {
        const target = middleTurn.getByTestId(testId);
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await expect.poll(() => effectiveOpacity(target)).toBe(1);
      }
      await expect.poll(() => opacity(footer)).toBe('1');
    } finally {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.detach();
    }
    const geometry = async () => ({
      footer: await footer.boundingBox(),
      next: await forkableTurn.boundingBox(),
      height: await footer.evaluate((el) => {
        let parent = el.parentElement;
        while (parent && parent.scrollHeight <= parent.clientHeight)
          parent = parent.parentElement;
        return parent?.scrollHeight;
      }),
    });
    const atRest = await geometry();
    await middleTurn
      .getByText('Completed the work for step 2.', { exact: true })
      .hover();
    await expect.poll(() => opacity(footer)).toBe('1');
    await expect
      .poll(() => effectiveOpacity(feedbackControl(window, 2)))
      .toBe(1);
    await expect
      .poll(() => opacity(ordinaryTurn.getByTestId('turn-timer-label')))
      .toBe('0');
    expect(await geometry()).toEqual(atRest);
    await footer.hover();
    await expect.poll(() => opacity(footer)).toBe('1');
    await window.mouse.move(5, 5);
    await expect.poll(() => opacity(footer)).toBe('0');

    await middleTurn.getByRole('link', { name: 'Footer reference' }).focus();
    await expect.poll(() => opacity(footer)).toBe('1');
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    await expect.poll(() => opacity(footer)).toBe('0');

    // Walk the actual tab order to a transparent footer action, then activate.
    const up = middleTurn.getByTestId('turn-feedback-up');
    await window.evaluate(() => document.activeElement?.blur());
    let reached = false;
    for (let step = 0; step < 150; step += 1) {
      await window.keyboard.press('Tab');
      reached = await up.evaluate(
        (el) => el === el.ownerDocument.activeElement,
      );
      if (reached) break;
    }
    expect(reached, 'Tab reaches the mounted footer action').toBe(true);
    await expect(up).toHaveCSS('outline-style', 'solid');
    await expect(up).toHaveCSS('outline-width', '2px');
    await expect.poll(() => opacity(footer)).toBe('1');
    await footer.hover();
    await window.mouse.move(5, 5);
    await expect.poll(() => opacity(footer)).toBe('1');
    await window.keyboard.press('Enter');
    await expect(feedbackControl(window, 2)).toHaveAttribute(
      'data-rating',
      'up',
    );
    await expect(up.locator('svg')).toHaveAttribute('fill', 'currentColor');
    await expect(up).toHaveCSS('border-top-width', '0px');
    await window.keyboard.press('Enter');
    await expect(feedbackControl(window, 2)).toHaveAttribute(
      'data-rating',
      'none',
    );
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    await expect.poll(() => opacity(footer)).toBe('0');
    await expect(
      forkableTurn.getByRole('button', { name: `Fork ${CHAT_UNIT_LABEL}` }),
    ).toBeVisible();
    await expect(
      forkableTurn.getByRole('button', {
        name: `Branch ${CHAT_UNIT_LABEL} into new worktree`,
      }),
    ).toBeVisible();
    await expect(forkableTurn.getByTestId('turn-share-session')).toBeVisible();
    // The ordinary turn genuinely has none of those trailing actions, so the
    // adjacency check below covers the stamp accessory with and without actions.
    await expect(
      ordinaryTurn.getByRole('button', { name: `Fork ${CHAT_UNIT_LABEL}` }),
    ).toHaveCount(0);
    await expect(ordinaryTurn.getByTestId('turn-share-session')).toHaveCount(0);

    // CAN-4278: the latest turn's Fork / Branch / Share are hover/focus-only,
    // and both hover and keyboard focus make them actually visible.
    const latestActions = [
      forkableTurn.getByRole('button', { name: `Fork ${CHAT_UNIT_LABEL}` }),
      forkableTurn.getByRole('button', {
        name: `Branch ${CHAT_UNIT_LABEL} into new worktree`,
      }),
      forkableTurn.getByTestId('turn-share-session'),
    ];
    for (const action of latestActions)
      await expect.poll(() => effectiveOpacity(action)).toBe(0);
    await forkableTurn
      .getByText('Completed the work for step 3.', { exact: false })
      .first()
      .hover();
    for (const action of latestActions)
      await expect.poll(() => effectiveOpacity(action)).toBe(1);
    // Every footer control shares the thumbs' icon treatment (one shared row
    // reset): the same muted colour and icon size, no border, no fill. Read
    // from every button in the row, so a new action cannot drift. A pressed
    // control (the seeded chat is already shared) keeps its state styling.
    const footerButtons = await forkableTurn
      .getByTestId('turn-timer')
      .evaluate((row) =>
        Array.from(row.querySelectorAll('button')).map((button) => {
          const style = getComputedStyle(button);
          const icon = button.querySelector('svg');
          return {
            label: button.getAttribute('aria-label'),
            pressed:
              button.getAttribute('aria-pressed') === 'true' ||
              button.hasAttribute('data-attention'),
            thumb: (button.getAttribute('data-testid') ?? '').startsWith(
              'turn-feedback-',
            ),
            color: style.color,
            icon: icon ? getComputedStyle(icon).width : null,
            border: style.borderTopWidth,
            background: style.backgroundColor,
          };
        }),
      );
    const reference = footerButtons.find((b) => b.thumb && !b.pressed);
    expect(reference, 'an unpressed thumb in the latest footer').toBeTruthy();
    const others = footerButtons.filter((b) => !b.thumb && !b.pressed);
    expect(others.length, 'latest footer actions').toBeGreaterThanOrEqual(2);
    for (const button of others) {
      expect(button.color, `${button.label} colour`).toBe(reference.color);
      expect(button.icon, `${button.label} icon size`).toBe(reference.icon);
      expect(button.border, `${button.label} border`).toBe('0px');
      expect(button.background, `${button.label} fill`).toBe(
        'rgba(0, 0, 0, 0)',
      );
    }
    await window.mouse.move(5, 5);
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    for (const action of latestActions)
      await expect.poll(() => effectiveOpacity(action)).toBe(0);
    // Keyboard: Tab from the latest turn's thumbs reaches each action in order.
    await forkableTurn.getByTestId('turn-feedback-down').focus();
    for (const action of latestActions) {
      let reached = false;
      for (let step = 0; step < 6 && !reached; step += 1) {
        await window.keyboard.press('Tab');
        reached = await action.evaluate(
          (el) =>
            el === document.activeElement ||
            el.contains(document.activeElement),
        );
      }
      expect(reached, 'Tab reaches the latest turn action').toBe(true);
      await expect.poll(() => effectiveOpacity(action)).toBe(1);
    }
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();

    for (const [name, turn] of [
      ['forkable', forkableTurn],
      ['ordinary', ordinaryTurn],
    ]) {
      const stamp = await turn.getByTestId('turn-timer-relative').boundingBox();
      const control = await turn
        .getByTestId('turn-feedback-control')
        .boundingBox();
      const label = await turn.getByTestId('turn-timer-label').boundingBox();
      expect(stamp, `${name} stamp bounding box`).not.toBeNull();
      expect(control, `${name} control bounding box`).not.toBeNull();
      expect(label, `${name} label bounding box`).not.toBeNull();
      const gap = control.x - (stamp.x + stamp.width);
      expect(gap, `${name} gap from stamp to thumbs`).toBeGreaterThanOrEqual(0);
      expect(gap, `${name} gap from stamp to thumbs`).toBeLessThanOrEqual(12);
      expect(control.x + control.width).toBeLessThanOrEqual(label.x + 1);
      expect(Math.abs(control.y - stamp.y)).toBeLessThanOrEqual(6);
    }

    // A real portaled footer menu retains reveal while focus leaves the turn,
    // then returns focus on Escape and releases reveal on an outside focus.
    const share = forkableTurn.getByTestId('turn-share-session');
    await share.click();
    const manage = window.getByTestId('turn-share-session-manage');
    await expect(manage).toBeVisible();
    const menuAction = manage.getByRole('menuitem').first();
    await expect(menuAction).toBeEnabled();
    await menuAction.focus();
    await expect(menuAction).toBeFocused();
    await manage.hover();
    await expect
      .poll(() => opacity(forkableTurn.getByTestId('turn-timer-label')))
      .toBe('1');
    await window.keyboard.press('Escape');
    await expect(manage).toHaveCount(0);
    await expect(share).toBeFocused();
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    await window.mouse.move(5, 5);
    await expect
      .poll(() => opacity(forkableTurn.getByTestId('turn-timer-label')))
      .toBe('0');

    // A menu item that closes its own menu (Comments) unmounts while focused,
    // so React delivers no blur. The footer must still release reveal once
    // focus moves elsewhere, instead of staying pinned visible.
    await share.click();
    await expect(manage).toBeVisible();
    const commentsItem = manage.getByTestId('turn-share-session-comments');
    await commentsItem.focus();
    await expect(commentsItem).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(manage).toHaveCount(0);
    const commentsModal = window.getByTestId('run-comments-modal');
    await expect(commentsModal).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(commentsModal).toHaveCount(0);
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    await window.mouse.move(5, 5);
    await expect
      .poll(() => opacity(forkableTurn.getByTestId('turn-timer-label')))
      .toBe('0');

    // ---- (a) Thumbs-up sets the rating, and clicking it again clears it.
    const turn1 = feedbackControl(window, 1);
    await turn1.getByTestId('turn-feedback-up').click();
    await expect(turn1).toHaveAttribute('data-rating', 'up');
    await expect(turn1.getByTestId('turn-feedback-up')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The rating round-tripped through `setTurnFeedback` (optimistic
    // `pending`, then `synced` once the fail-soft IPC acks the local queue),
    // so it is never left at the unrated `none` sentinel. The exact settled
    // value is not asserted: it depends on cloud reachability, which this
    // spec deliberately does not control.
    await expect(turn1).not.toHaveAttribute('data-sync-state', 'none');
    // A thumbs-up must NOT open the detail dialog.
    await expect(window.getByTestId('turn-feedback-dialog')).toHaveCount(0);

    await turn1.getByTestId('turn-feedback-up').click();
    await expect(turn1).toHaveAttribute('data-rating', 'none');
    await expect(turn1).toHaveAttribute('data-sync-state', 'none');

    // ---- (c, first half) Thumbs-down then Skip keeps the rating. The rating
    // is recorded before the dialog opens, so dismissing it can never undo it.
    const turn2 = feedbackControl(window, 2);
    await turn2.getByTestId('turn-feedback-down').click();
    const dialog = window.getByTestId('turn-feedback-dialog');
    await expect(dialog).toBeVisible();
    await expect(turn2).toHaveAttribute('data-rating', 'down');
    await window.mouse.move(5, 5);
    await dialog
      .getByTestId('turn-feedback-comment')
      .fill('Portal focus remains in the turn interaction');
    await expect.poll(() => opacity(footer)).toBe('1');
    await dialog.getByTestId('turn-feedback-skip').click();
    await expect(dialog).toHaveCount(0);
    await expect(turn2.getByTestId('turn-feedback-down')).toBeFocused();
    await expect(turn2).toHaveAttribute('data-rating', 'down');

    // ---- (b) Thumbs-down → reason → comment → submit.
    // Re-clicking the selected thumb clears it, so clear and re-rate to get a
    // second dialog on the same turn.
    await turn2.getByTestId('turn-feedback-down').click();
    await expect(turn2).toHaveAttribute('data-rating', 'none');
    await turn2.getByTestId('turn-feedback-down').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('turn-feedback-reasons')).toBeVisible();
    // The bug-report escape hatch is the only prose left in the dialog: the
    // privacy paragraph was removed because nothing beyond the typed comment
    // is ever collected, which the dialog itself already shows.
    await expect(
      dialog.getByTestId('turn-feedback-open-app-feedback'),
    ).toBeVisible();
    await expect(dialog.getByTestId('turn-feedback-privacy')).toHaveCount(0);

    // Toggle-group semantics, not radio: the chips deselect on re-click, so
    // they expose `aria-pressed` rather than `aria-checked`.
    const reason = dialog.getByTestId('turn-feedback-reason-got-stuck');
    await expect(reason).toHaveAttribute('aria-pressed', 'false');
    await reason.click();
    await expect(reason).toHaveAttribute('aria-pressed', 'true');

    const comment = dialog.getByTestId('turn-feedback-comment');
    await comment.fill('It looped over the same file three times.');
    await expect(comment).toHaveValue(
      'It looped over the same file three times.',
    );

    await dialog.getByTestId('turn-feedback-submit').click();
    await expect(dialog).toHaveCount(0);
    await expect(turn2).toHaveAttribute('data-rating', 'down');

    // ---- (c, second half) Thumbs-down then Escape keeps the rating.
    const turn3 = feedbackControl(window, 3);
    await turn3.getByTestId('turn-feedback-down').click();
    await expect(dialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(turn3).toHaveAttribute('data-rating', 'down');

    // CAN-4278: rated and unrated thumbs stay visible at rest while the rest
    // of the footer fades.
    await window
      .locator('[data-chat-composer-root="true"]')
      .getByRole('textbox')
      .first()
      .focus();
    await window.mouse.move(5, 5);
    for (const order of [2, 3]) {
      await expect
        .poll(() => effectiveOpacity(feedbackControl(window, order)))
        .toBe(1);
      await expect
        .poll(() =>
          opacity(turnScope(window, order).getByTestId('turn-timer-label')),
        )
        .toBe('0');
    }
    await expect
      .poll(() => effectiveOpacity(feedbackControl(window, 1)))
      .toBe(1);

    // ---- (e) The read-only TranscriptViewer renders no control at all.
    await app.openAuditPage();
    await window
      .getByTestId(`audit-transcript-button-${AUDIT_ENTRY_ID}`)
      .click();
    await expect(window.getByTestId('audit-transcript-modal')).toBeVisible();
    const richTranscript = window.getByTestId('audit-transcript-rich');
    await expect(richTranscript).toBeVisible();
    await expect(
      richTranscript.getByText('read-only transcript assistant output'),
    ).toBeVisible();
    // A COMPLETED turn group really did render here — so the absent control
    // below is the `chatId === undefined` read-only gate, not an incomplete
    // turn that would never show a control anyway.
    await expect(
      richTranscript.locator(
        '[data-testid="turn-timer"][data-state="completed"]',
      ),
    ).not.toHaveCount(0);
    await expect
      .poll(() =>
        opacity(richTranscript.getByTestId('turn-timer-label').first()),
      )
      .toBe('1');
    await expect(
      richTranscript.locator('[data-testid="turn-feedback-control"]'),
    ).toHaveCount(0);
    // Nothing anywhere in the modal, including its chrome. Scoped to the modal
    // on purpose: `MainPage` stays mounted (hidden) behind every other page —
    // see the renderer startup notes in CLAUDE.md — so the three chat controls
    // from the worktree transcript are still in the document and a window-wide
    // count would assert the opposite of what it looks like it asserts.
    await expect(
      window
        .getByTestId('audit-transcript-modal')
        .locator('[data-testid="turn-feedback-control"]'),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('can-1521-turn-feedback.png'),
    });

    // The renderer debounces chat-tab persistence at 500ms; give it margin to
    // reach main before quitting (main's own disk debounce flushes on quit).
    await window.waitForTimeout(1500);
  } finally {
    // Keep the data dir so launch 2 can read the persisted `turnFeedback`.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2 (same userDataDir): ratings survive a relaunch ------------
  const second = await launchCanopy({ userDataDir });
  try {
    const { window } = await openWorktreeChat(second.electronApp);

    // The Escape-dismissed thumbs-down (c) and the submitted one (b) both
    // survive, because the rating lives on the persisted chat tab and is
    // written independently of the dialog.
    await expect(feedbackControl(window, 3)).toHaveAttribute(
      'data-rating',
      'down',
    );
    await expect(feedbackControl(window, 2)).toHaveAttribute(
      'data-rating',
      'down',
    );
    // Turn 1's rating was CLEARED, and clearing retracts it everywhere: the
    // queued outbox entry is dropped (`turn-feedback:clear`) and any server
    // row is deleted. `ChatContent` re-fetches this chat's ratings on mount,
    // so a clear that had stayed local would resurrect the thumb right here —
    // this assertion is the regression guard for that.
    await expect(feedbackControl(window, 1)).toHaveAttribute(
      'data-rating',
      'none',
    );
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
