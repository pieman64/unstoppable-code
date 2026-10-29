/**
 * Server-rendered tests for the shared {@link WorktreeRow}. Verifies the
 * badge visibility per prop, the PR badge rendering for each `state`, and
 * the diff-stats / runtime treatment.
 */
import { renderToString } from 'react-dom/server';
import {
  DepthBadgeTooltipContent,
  DiffStatsBadge,
  PrBadgeTooltipContent,
  WorktreeRow,
  WorktreeRowActionChip,
  worktreeRowActionButtonClass,
} from '../WorktreeRow';
import type {
  WorktreeRowMergeQueuePhase,
  WorktreeRowPrStatus,
} from '../WorktreeRow';

describe('WorktreeRow', () => {
  it('suffixes descendant automation ids for mounted row copies', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/pinned"
        branchName="feature/pinned"
        uiStatus="planning"
        textScale="sidebar"
        graphBuildStatus="building"
        lastKnownPrStatus={{
          state: 'open',
          label: 'PR #2495',
          reviewStatus: 'approved',
          isMergeReady: true,
        }}
        testIdSuffix="-pin-top"
      />,
    );

    expect(html).toContain('worktree-row-planning-approval-pin-top');
    expect(html).toContain('worktree-row-pr-badge-pin-top');
    expect(html).toContain('worktree-row-pr-approved-pin-top');
    expect(html).toContain('worktree-row-graph-badge-pin-top');
    expect(html).not.toContain('data-testid="worktree-row-pr-badge"');
  });

  // Specs select the title with a strict locator scoped to one row, so a
  // second element carrying the id (the identity line once did) breaks them.
  it('exposes exactly one title automation id per row', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/one-title"
        branchName="feature/one-title"
        uiStatus="working"
        textScale="sidebar"
      />,
    );

    expect(html.split('data-testid="worktree-row-title"')).toHaveLength(2);
  });

  describe('classic status system (subject icons + state colors)', () => {
    it('shows the loader beside the single top-priority attention dot', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="working"
          textScale="sidebar"
          isStreaming
          hasUnread
          hasPendingQuestion
        />,
      );
      // The working spinner coexists with ONE attention dot; needs-input
      // outranks unread, so the orange question dot replaces the blue dot.
      const questionIndex = html.indexOf('data-testid="worktree-row-question"');
      const spinnerIndex = html.indexOf(
        'data-testid="worktree-row-classic-streaming-spinner"',
      );
      expect(questionIndex).toBeGreaterThan(-1);
      expect(spinnerIndex).toBeGreaterThan(-1);
      // The dot keeps the anchor (right-most) slot beside the action column.
      expect(spinnerIndex).toBeLessThan(questionIndex);
      expect(html).not.toContain('data-testid="worktree-row-unread"');
      expect(html).toContain('h-2 w-2 rounded-full bg-fg-warning');
      expect(html).toContain('fg-accent');
    });

    it('sizes the trailing slots to the action-button rhythm', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="working"
          textScale="sidebar"
          isStreaming
          hasPendingQuestion
        />,
      );
      // Same slot size and gap as the hover action buttons (24px boxes,
      // gap-0.5), so the dots and spinner line up with the button column;
      // the -mr-0.5 nudge puts the last slot's center exactly under the
      // right-most action button.
      expect(html).toContain(
        'inline-flex h-5 shrink-0 items-center justify-end gap-0.5 -mr-0.5',
      );
      const slotBoxes = html.match(/inline-flex h-5 w-6 /g) ?? [];
      expect(slotBoxes.length).toBeGreaterThanOrEqual(2);
    });

    it('promotes the question glyph into the leading slot with the warning dot trailing', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="unread"
          textScale="sidebar"
          hasUnread
          hasPendingQuestion
          onUnreadIconMouseEnter={() => undefined}
        />,
      );
      // The leading slot names the subject: the question-mark glyph in the
      // needs-input orange (matching the plan shield and the question dot).
      const glyphIndex = html.indexOf(
        'data-testid="worktree-row-question-glyph"',
      );
      expect(glyphIndex).toBeGreaterThan(-1);
      expect(glyphIndex).toBeLessThan(html.indexOf('<p title="b"'));
      const glyphChunk = html.slice(glyphIndex, glyphIndex + 400);
      expect(glyphChunk).toContain('fg-warning');
      expect(glyphChunk).not.toContain('fg-secondary');
      expect(html).toContain('h-2 w-2 rounded-full bg-fg-warning');
      expect(html).toContain('data-testid="worktree-row-question"');
      // The glyph hosts the chat-preview popover (focusable trigger).
      expect(html).toMatch(
        /tabindex="0"[^>]*data-testid="worktree-row-question-glyph"/,
      );

      // The question glyph outranks the plan-review shield in the finalized
      // chain; the question dot still shows trailing.
      const withShield = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="planning"
          textScale="sidebar"
          awaitingApproval
          hasPendingQuestion
        />,
      );
      expect(withShield).toContain('data-testid="worktree-row-question-glyph"');
      expect(withShield).not.toContain(
        'data-testid="worktree-row-awaiting-approval"',
      );
      expect(withShield).toContain('data-testid="worktree-row-question"');

      // Pipeline glyphs outrank the question glyph: the pipeline names the
      // leading slot while the question keeps the trailing orange dot.
      const withPipeline = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="working"
          textScale="sidebar"
          hasPendingQuestion
          pipelineStatus="running"
        />,
      );
      expect(withPipeline).toContain(
        'data-testid="worktree-row-working-pipeline"',
      );
      expect(withPipeline).not.toContain(
        'data-testid="worktree-row-question-glyph"',
      );
      expect(withPipeline).toContain('data-testid="worktree-row-question"');

      // Done rows still surface a waiting question: the done checkmark is
      // only the fallback when nothing else claims the slot.
      const done = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="done"
          runtimeState="done"
          textScale="sidebar"
          hasPendingQuestion
        />,
      );
      expect(done).toContain('data-testid="worktree-row-question-glyph"');
      expect(done).toContain('data-testid="worktree-row-question"');
      expect(done).not.toContain('data-glyph="circle-check"');
    });

    it('lights the needs-input dot for a pending tool approval', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hasPendingToolApproval
        />,
      );

      // Orange: an approval is needs-input severity, same tier as a question.
      expect(html).toContain('data-testid="worktree-row-tool-approval"');
      expect(html).toContain('h-2 w-2 rounded-full bg-fg-warning');
      expect(html).toContain('aria-label="Approval needed"');
    });

    it('ranks the approval dot under a question and over every unread source', () => {
      // A question outranks an approval: answering it is what unblocks the
      // approval card the user is about to land on.
      const withQuestion = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hasPendingQuestion
          hasPendingToolApproval
        />,
      );
      expect(withQuestion).toContain('data-testid="worktree-row-question"');
      expect(withQuestion).not.toContain(
        'data-testid="worktree-row-tool-approval"',
      );

      // An approval outranks a failed pipeline, unread chat, and an unseen
      // pipeline result: it is the only one of the four that blocks an agent.
      const overEverythingElse = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="unread"
          textScale="sidebar"
          hasUnread
          hasPendingToolApproval
          pipelineStatus="unseen-failure"
        />,
      );
      expect(overEverythingElse).toContain(
        'data-testid="worktree-row-tool-approval"',
      );
      expect(overEverythingElse).not.toContain(
        'data-testid="worktree-row-pipeline-attention"',
      );
      expect(overEverythingElse).not.toContain(
        'data-testid="worktree-row-unread"',
      );
    });

    it('keeps the approval dot out of the leading slot', () => {
      // Deliberately dot-only: spending a glyph (a question mark or a
      // shield) on approvals would add icon vocabulary for a state the
      // severity colour already carries.
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hasPendingToolApproval
          terminalStatus="running"
        />,
      );

      expect(html).toContain('data-testid="worktree-row-tool-approval"');
      expect(html).not.toContain('data-testid="worktree-row-question-glyph"');
      // The leading slot still promotes the next subject in the chain.
      expect(html).toContain('data-testid="worktree-row-terminal-badge"');
    });

    it('drops the approval dot on a setup-phase row', () => {
      // While the worktree is still being created there is no agent to block.
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          setupPhase="running-setup"
          hasPendingToolApproval
        />,
      );

      expect(html).not.toContain('data-testid="worktree-row-tool-approval"');
    });

    it('shows the failed-pipeline dot over the unread dot, unless a question waits', () => {
      // Failure outranks unread: the red severity dot takes the single dot
      // slot and the leading pipeline glyph turns red.
      const failed = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="unread"
          textScale="sidebar"
          hasUnread
          pipelineStatus="unseen-failure"
        />,
      );
      expect(failed).toContain('data-testid="worktree-row-pipeline-attention"');
      expect(failed).toContain('bg-fg-destructive');
      expect(failed).not.toContain('data-testid="worktree-row-unread"');
      expect(failed).toMatch(/fg-destructive[^>]*>\s*<svg[^>]*data-app-icon/);

      // With a question waiting, the dot stays needs-input orange (dot
      // priority is unchanged) while the leading slot goes to the red
      // pipeline glyph — pipeline results outrank the question glyph.
      const question = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="unread"
          textScale="sidebar"
          hasUnread
          hasPendingQuestion
          pipelineStatus="unseen-failure"
        />,
      );
      expect(question).toContain('data-testid="worktree-row-pipeline-glyph"');
      expect(question).toContain('data-testid="worktree-row-question"');
      expect(question).not.toContain(
        'data-testid="worktree-row-question-glyph"',
      );
      expect(question).not.toContain(
        'data-testid="worktree-row-pipeline-attention"',
      );
      expect(question).not.toContain('data-testid="worktree-row-unread"');

      // Without a failure, chat unread owns the blue dot; an unseen success
      // hands the blue dot to the pipeline instead.
      const unreadWins = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="unread"
          textScale="sidebar"
          hasUnread
          pipelineStatus="unseen"
        />,
      );
      expect(unreadWins).toContain('data-testid="worktree-row-unread"');
      expect(unreadWins).not.toContain(
        'data-testid="worktree-row-pipeline-attention"',
      );
    });

    it('promotes script, watcher, and scheduled icons into an empty leading slot', () => {
      // With no higher-priority leading indicator (shield, question,
      // pipeline, done/planning), the subject icon moves into the leading
      // slot and its subtitle badge is suppressed. Priority within the
      // fallbacks: script running > watchers > scheduled.
      const script = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          scriptStatus="running"
        />,
      );
      const scriptBadgeIndex = script.indexOf(
        'data-testid="worktree-row-script-badge"',
      );
      expect(scriptBadgeIndex).toBeGreaterThan(-1);
      expect(scriptBadgeIndex).toBeLessThan(script.indexOf('<p title="b"'));
      // No duplicate subtitle badge.
      expect(
        script.match(/data-testid="worktree-row-script-badge"/g),
      ).toHaveLength(1);
      // The promoted glyph nests the running cyan on its inner icon span.
      expect(script.slice(scriptBadgeIndex, scriptBadgeIndex + 400)).toContain(
        'fg-info',
      );

      const watchers = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hasIdleWatcherChats
        />,
      );
      const watcherIndex = watchers.indexOf(
        'data-testid="worktree-row-watchers"',
      );
      expect(watcherIndex).toBeGreaterThan(-1);
      expect(watcherIndex).toBeLessThan(watchers.indexOf('<p title="b"'));
      expect(
        watchers.match(/data-testid="worktree-row-watchers"/g),
      ).toHaveLength(1);

      const scheduled = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hasScheduledMessages
        />,
      );
      const scheduledIndex = scheduled.indexOf(
        'data-testid="worktree-row-scheduled-messages"',
      );
      expect(scheduledIndex).toBeGreaterThan(-1);
      expect(scheduledIndex).toBeLessThan(scheduled.indexOf('<p title="b"'));

      // Overlap: the top fallback takes the leading slot, the rest keep
      // their subtitle badges. Finalized fallback order: split > watchers >
      // scheduled > script > hook > terminal > graph.
      const all = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          scriptStatus="running"
          hasIdleWatcherChats
          hasScheduledMessages
        />,
      );
      const titleIndex = all.indexOf('<p title="b"');
      expect(all.indexOf('data-testid="worktree-row-watchers"')).toBeLessThan(
        titleIndex,
      );
      expect(
        all.indexOf('data-testid="worktree-row-script-badge"'),
      ).toBeGreaterThan(titleIndex);
      expect(
        all.indexOf('data-testid="worktree-row-scheduled-messages"'),
      ).toBeGreaterThan(titleIndex);

      // Newly promotable subjects claim the empty slot too, tint intact,
      // subtitle badge suppressed.
      const terminal = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          terminalStatus="unseen-failure"
        />,
      );
      const terminalIndex = terminal.indexOf(
        'data-testid="worktree-row-terminal-badge"',
      );
      expect(terminalIndex).toBeGreaterThan(-1);
      expect(terminalIndex).toBeLessThan(terminal.indexOf('<p title="b"'));
      expect(
        terminal.match(/data-testid="worktree-row-terminal-badge"/g),
      ).toHaveLength(1);
      expect(terminal.slice(terminalIndex - 200, terminalIndex)).toContain(
        'fg-destructive-strong',
      );

      const hook = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          hookStatus="running"
        />,
      );
      const hookIndex = hook.indexOf('data-testid="worktree-row-hook-badge"');
      expect(hookIndex).toBeGreaterThan(-1);
      expect(hookIndex).toBeLessThan(hook.indexOf('<p title="b"'));
      expect(hook.match(/data-testid="worktree-row-hook-badge"/g)).toHaveLength(
        1,
      );

      const split = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          splitStatus="review"
        />,
      );
      const splitIndex = split.indexOf(
        'data-testid="worktree-row-split-badge"',
      );
      expect(splitIndex).toBeGreaterThan(-1);
      expect(splitIndex).toBeLessThan(split.indexOf('<p title="b"'));
      expect(
        split.match(/data-testid="worktree-row-split-badge"/g),
      ).toHaveLength(1);

      const graph = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          graphBuildStatus="building"
        />,
      );
      const graphIndex = graph.indexOf(
        'data-testid="worktree-row-graph-badge"',
      );
      expect(graphIndex).toBeGreaterThan(-1);
      expect(graphIndex).toBeLessThan(graph.indexOf('<p title="b"'));
      expect(
        graph.match(/data-testid="worktree-row-graph-badge"/g),
      ).toHaveLength(1);

      // A pipeline outranks the fallbacks: the script badge stays in the
      // subtitle when a pipeline glyph owns the leading slot.
      const withPipeline = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="working"
          textScale="sidebar"
          pipelineStatus="running"
          scriptStatus="running"
        />,
      );
      expect(withPipeline).toContain(
        'data-testid="worktree-row-working-pipeline"',
      );
      expect(
        withPipeline.indexOf('data-testid="worktree-row-script-badge"'),
      ).toBeGreaterThan(withPipeline.indexOf('<p title="b"'));

      // Done is the fallback, not the winner: an active subject (script
      // running) is still promoted into the leading slot on a done row, and
      // the checkmark yields.
      const done = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="done"
          runtimeState="done"
          textScale="sidebar"
          scriptStatus="running"
        />,
      );
      expect(done).not.toContain('data-glyph="circle-check"');
      const doneScriptIndex = done.indexOf(
        'data-testid="worktree-row-script-badge"',
      );
      expect(doneScriptIndex).toBeGreaterThan(-1);
      expect(doneScriptIndex).toBeLessThan(done.indexOf('<p title="b"'));

      // With no other subject active, the done checkmark keeps the slot.
      const doneQuiet = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="done"
          runtimeState="done"
          textScale="sidebar"
        />,
      );
      expect(doneQuiet).toContain('data-glyph="circle-check"');
    });

    it('colors the leading pipeline glyph by its state', () => {
      const cases = [
        { pipelineStatus: 'running', color: 'fg-secondary' },
        { pipelineStatus: 'paused', color: 'fg-warning' },
        { pipelineStatus: 'unseen', color: 'fg-success' },
        { pipelineStatus: 'unseen-failure', color: 'fg-destructive' },
      ] as const;
      for (const { pipelineStatus, color } of cases) {
        const html = renderToString(
          <WorktreeRow
            branchLabel="b"
            branchName="b"
            uiStatus="idle"
            textScale="sidebar"
            pipelineStatus={pipelineStatus}
          />,
        );
        expect(html).toMatch(
          new RegExp(`${color}[^>]*>\\s*<svg[^>]*data-app-icon`),
        );
      }
    });

    it('colors the terminal badge by state and forwards the status attribute', () => {
      const cases = [
        {
          terminalStatus: 'running',
          color: 'fg-secondary',
          label: 'Terminal running',
        },
        {
          terminalStatus: 'unseen',
          color: 'fg-info',
          label: 'Terminal completed',
        },
        {
          terminalStatus: 'unseen-failure',
          color: 'fg-destructive-strong',
          label: 'Terminal failed',
        },
      ] as const;
      for (const { terminalStatus, color, label } of cases) {
        const html = renderToString(
          <WorktreeRow
            branchLabel="b"
            branchName="b"
            uiStatus="idle"
            textScale="sidebar"
            terminalStatus={terminalStatus}
          />,
        );
        expect(html).toContain('data-testid="worktree-row-terminal-badge"');
        expect(html).toContain(`data-terminal-status="${terminalStatus}"`);
        expect(html).toContain(`aria-label="${label}"`);
        expect(html).toMatch(
          new RegExp(`${color}[^>]*data-testid="worktree-row-terminal-badge"`),
        );
      }
    });

    it('colors the script and hook badges with the running info ink', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          scriptStatus="running"
          hookStatus="running"
        />,
      );
      // The script promotes to the leading slot (cyan on its inner span);
      // the hook badge stays a cyan subtitle badge.
      const scriptIndex = html.indexOf(
        'data-testid="worktree-row-script-badge"',
      );
      expect(scriptIndex).toBeGreaterThan(-1);
      expect(html.slice(scriptIndex, scriptIndex + 400)).toContain('fg-info');
      expect(html).toMatch(/fg-info[^>]*data-testid="worktree-row-hook-badge"/);
    });

    it('tints the classic split badge by state with operational tooltip dots', () => {
      const active = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          splitStatus="active"
          splitStatusMessage="Carving child branch (2/4)"
        />,
      );
      // Running stays neutral; the rail spinner says it is running, and the
      // finished result keeps the info blue.
      expect(active).toMatch(
        /fg-secondary[^>]*data-testid="worktree-row-split-badge"/,
      );
      expect(active).not.toMatch(
        /fg-info[^>]*data-testid="worktree-row-split-badge"/,
      );
      expect(active).not.toContain('bg-sky-400');
      expect(active).not.toContain('bg-amber-400');

      const review = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          splitStatus="review"
          splitStatusMessage="Plan ready for review"
        />,
      );
      expect(review).toMatch(
        /fg-warning[^>]*data-testid="worktree-row-split-badge"/,
      );
      expect(review).not.toContain('bg-amber-400');

      const done = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          splitStatus="done"
          splitStatusMessage="Split complete"
        />,
      );
      expect(done).toMatch(
        /fg-info[^>]*data-testid="worktree-row-split-badge"/,
      );
    });
  });

  describe('native title migration (CAN-2799)', () => {
    // Status indicators explain themselves through the rich hover tooltip
    // (instant on mouseenter/focus); a native `title` on the same element
    // would add the laggy macOS tooltip on top of it. Only the truncating
    // branch label keeps its native title.
    it('keeps status glyph labels out of native titles in the compact layout', () => {
      // Only the trailing status rail is inspected: the truncating subtitle
      // text keeps its own native title (a text-overflow aid, not hover help).
      const statusRail = (html: string): string =>
        html.slice(html.indexOf('data-testid="worktree-row-status-rail"'));

      const working = renderToString(
        <WorktreeRow branchLabel="b" branchName="b" uiStatus="working" />,
      );
      expect(statusRail(working)).toContain('aria-label="Working"');
      expect(statusRail(working)).not.toContain('title=');

      const streaming = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          isStreaming
        />,
      );
      expect(statusRail(streaming)).toContain('aria-label="Working"');
      expect(statusRail(streaming)).not.toContain('title=');

      const question = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          hasPendingQuestion
        />,
      );
      expect(statusRail(question)).toContain('aria-label="Question waiting"');
      expect(statusRail(question)).not.toContain('title=');

      const setup = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          setupPhase="running-setup"
        />,
      );
      expect(statusRail(setup)).toContain('aria-label="Running setup…"');
      expect(statusRail(setup)).not.toContain('title=');
    });

    it('keeps status glyph labels out of native titles in the classic sidebar', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="tirish/2026-foo"
          uiStatus="idle"
          textScale="sidebar"
          isStreaming
          hasPendingQuestion
          hasUnread
          awaitingApproval
          pipelineStatus="running"
          isDiscovering
        />,
      );
      expect(html).toContain('title="tirish/2026-foo"');
      for (const label of [
        'Working',
        'Question waiting',
        'Unread messages',
        'Review plan',
        'Pipeline running',
        'Discovering environment…',
      ]) {
        expect(html).not.toContain(`title="${label}"`);
      }
    });
  });

  it('renders the branch label and the raw branch tooltip', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/foo"
        branchName="tirish/2026-foo"
        uiStatus="idle"
      />,
    );
    expect(html).toContain('feature/foo');
    expect(html).toContain('title="tirish/2026-foo"');
  });

  it('keeps an empty fixed leading icon slot for an idle row', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="New Task"
        branchName="dev-beaver"
        uiStatus="idle"
        textScale="sidebar"
      />,
    );

    expect(html).toContain('data-testid="worktree-row-leading-slot"');
    expect(html).toContain('data-testid="worktree-idle-status-placeholder"');
    expect(html).not.toContain('drag-handle');
  });

  it('restores the classic leading status and subtitle icon hierarchy', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Classic task"
        branchName="classic-task"
        worktreeId="calm-otter"
        uiStatus="working"
        textScale="sidebar"
        pipelineStatus="running"
        terminalStatus="unseen-failure"
        scriptStatus="running"
        hasUnread
      />,
    );

    expect(html).toContain('data-worktree-layout="classic"');
    // Working promotes the pipeline icon into the leading slot; the
    // subtitle no longer duplicates a pipeline badge for it. Subject badges
    // (terminal, script) carry their own state tints.
    expect(html).toContain('data-testid="worktree-row-working-pipeline"');
    expect(html).not.toContain('h-2 w-2 rounded-full bg-fg-purple');
    expect(html).not.toContain('data-testid="worktree-row-pipeline-badge"');
    expect(html).not.toContain('text-sky-400');
    expect(html).toContain('data-testid="worktree-row-terminal-badge"');
    expect(html).toContain('data-testid="worktree-row-script-badge"');
    expect(html).toContain('data-testid="worktree-row-unread"');
    expect(html).not.toContain('text-amber-400');
    expect(html).toContain('calm-otter');
    expect(html).toContain('aria-label="Pipeline running"');
    expect(html).toContain('aria-label="Terminal failed"');
    expect(html).toContain('aria-label="Scripts running"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      'flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap',
    );
    expect(html).toContain('block min-w-0 flex-1 truncate whitespace-nowrap');
    expect(html).not.toContain('data-testid="worktree-row-status-rail"');
  });

  it('never renders the classic subtitle pipeline badge', () => {
    // The leading indicator system owns pipeline state in the sidebar: a
    // running pipeline promotes the leading icon, and unseen/paused pipeline
    // results surface through the leading glyph + trailing severity dot. A
    // subtitle badge would duplicate (or contradict) that, so it is gone.
    for (const pipelineStatus of [
      'running',
      'unseen',
      'unseen-failure',
      'paused',
    ] as const) {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          pipelineStatus={pipelineStatus}
        />,
      );
      expect(html).not.toContain('data-testid="worktree-row-pipeline-badge"');
    }
  });

  it('hosts the pipeline popover on the promoted working icon', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        textScale="sidebar"
        pipelineStatus="running"
        onPipelineIconMouseEnter={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="worktree-row-working-pipeline"');
    // The interactive wrapper is focusable so the popover works via keyboard
    // (the only focusable element in this render is that wrapper).
    expect(html).toContain('tabindex="0"');
  });

  it('uses the pre-redesign planning and done colors in classic rows', () => {
    const planning = renderToString(
      <WorktreeRow
        branchLabel="Planning"
        branchName="planning"
        uiStatus="planning"
        textScale="sidebar"
      />,
    );
    const done = renderToString(
      <WorktreeRow
        branchLabel="Done"
        branchName="done"
        uiStatus="done"
        runtimeState="done"
        textScale="sidebar"
      />,
    );

    // Planning promotes the orange approval shield into the leading slot.
    expect(planning).toContain('data-testid="worktree-row-planning-approval"');
    expect(planning).toContain('fg-warning');
    expect(planning).not.toContain('h-2 w-2 rounded-full bg-fg-warning');
    expect(done).toContain('fg-purple');
    expect(done).not.toContain('text-purple-400');
    // Done titles keep the same text color as every other row — no dimming.
    expect(done).not.toContain('opacity-70');
    // Done uses the circled-checkmark glyph (DoneCheckIcon design asset).
    expect(done).toContain('data-glyph="circle-check"');
    expect(done).not.toContain('polyline');
    expect(done).not.toContain('data-testid="worktree-row-status-rail"');
  });

  it('replaces the classic dot with one streaming spinner while streaming', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        textScale="sidebar"
        isStreaming
      />,
    );
    // One indicator: the live spinner takes over in the accent color on the
    // RIGHT side of the label line; no solid dot and no stacked spinner.
    expect(html).toContain(
      'data-testid="worktree-row-classic-streaming-spinner"',
    );
    expect(html).toContain('fg-accent');
    expect(html).not.toContain('h-2 w-2 rounded-full bg-fg-purple');
    expect(html).not.toContain('fg-purple');
    expect(
      html.indexOf('data-testid="worktree-row-classic-streaming-spinner"'),
    ).toBeGreaterThan(html.indexOf('<p title="b"'));
  });

  it('hosts the unread chat preview on the classic unread dot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        hasUnread
        textScale="sidebar"
        onUnreadIconMouseEnter={() => undefined}
      />,
    );
    // The blue unread dot is the hover/focus target for the chat preview
    // popover; the amber subtitle badge is gone.
    expect(html).toContain('data-testid="worktree-row-unread"');
    // 8px status dot in the trailing slot.
    expect(html).toContain('h-2 w-2 rounded-full bg-fg-blue');
    expect(html).toContain('aria-label="Unread messages"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('text-amber-400');
    // The dot renders on the RIGHT side of the label line, not the leading
    // slot, and above the subtitle.
    expect(html.indexOf('data-testid="worktree-row-unread"')).toBeGreaterThan(
      html.indexOf('<p title="b"'),
    );
    expect(html.indexOf('data-testid="worktree-row-unread"')).toBeLessThan(
      html.indexOf('worktree-row-subtitle'),
    );
  });

  it('renders every worktree loader in the accent color', () => {
    const classicSetup = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        textScale="sidebar"
        setupPhase="running-setup"
      />,
    );
    expect(classicSetup).toMatch(
      /worktree-row-trailing-slot[\s\S]{0,400}?fg-accent/,
    );

    // Default text scale exercises the rail loader path (h-6 wrapper with
    // the nested h-4 spinner), which the classic assertion above cannot cover.
    const railSetup = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="running-setup"
      />,
    );
    expect(railSetup).toMatch(
      /inline-flex h-4 w-4 items-center justify-center"><span class="[^"]*fg-accent/,
    );

    const railStreaming = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        isStreaming
      />,
    );
    expect(railStreaming).toContain('fg-accent');
    expect(railStreaming).not.toContain('fg-blue');

    const discovering = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="env"
        uiStatus="idle"
        isDiscovering
        textScale="sidebar"
      />,
    );
    expect(discovering).toMatch(/aria-label="Discovering environment"/);
    expect(discovering).toContain('fg-accent');
  });

  it('keeps the approval shield reachable when unread or streaming outranks planning', () => {
    // Background plan-exit requests mark the worktree unread, and streaming
    // can also outrank planning — the actionable approval shield must still
    // render and host its popover.
    for (const props of [
      { uiStatus: 'unread', hasUnread: true },
      { uiStatus: 'working', isStreaming: true },
    ] as const) {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          awaitingApproval
          textScale="sidebar"
          onApprovalIconMouseEnter={() => undefined}
          {...props}
        />,
      );
      expect(html).toContain('data-testid="worktree-row-awaiting-approval"');
      expect(html).toContain('data-glyph="map"');
    }
  });

  it('hosts the plan-approval popover on the classic planning shield', () => {
    const approval = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="planning"
        awaitingApproval
        textScale="sidebar"
        onApprovalIconMouseEnter={() => undefined}
      />,
    );
    // The shield is the approval hover/focus target; the amber subtitle
    // badge is gone. The approval branch renders its own shield (uiStatus may
    // be outranked), so assert the glyph itself rather than the indicator.
    expect(approval).toContain('data-testid="worktree-row-awaiting-approval"');
    expect(approval).toContain('data-glyph="map"');
    expect(approval).toContain('fg-warning');
    expect(approval).toContain('tabindex="0"');
    expect(approval).toContain('aria-label="Review plan"');
    expect(approval).not.toContain('text-amber-400');

    // A paused pipeline gets the pipeline glyph (not the shield — that means
    // "review plan"), labeled for what paused.
    const paused = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="planning"
        pipelineStatus="paused"
        textScale="sidebar"
      />,
    );
    expect(paused).toContain('data-testid="worktree-row-paused-pipeline"');
    expect(paused).toContain('aria-label="Pipeline paused"');
    expect(paused).not.toContain(
      'data-testid="worktree-row-planning-approval"',
    );
    expect(paused).not.toContain(
      'data-testid="worktree-row-awaiting-approval"',
    );
  });

  it('reserves the pipeline glyph for a running pipeline', () => {
    // Portal rows can be working (busy / running run) without a pipeline;
    // they get the live spinner, not the pipeline icon.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        textScale="sidebar"
      />,
    );
    expect(html).toContain(
      'data-testid="worktree-row-classic-streaming-spinner"',
    );
    expect(html).not.toContain('data-testid="worktree-row-working-pipeline"');
  });

  it('lets every pipeline glyph state outrank the done checkmark', () => {
    // Done is only the fallback: pipeline activity/results still claim the
    // leading slot on a done row, and unseen results keep their severity dot.
    const cases = [
      { pipelineStatus: 'running', glyph: 'worktree-row-working-pipeline' },
      { pipelineStatus: 'paused', glyph: 'worktree-row-paused-pipeline' },
      { pipelineStatus: 'unseen', glyph: 'worktree-row-pipeline-glyph' },
      {
        pipelineStatus: 'unseen-failure',
        glyph: 'worktree-row-pipeline-glyph',
      },
    ] as const;
    for (const { pipelineStatus, glyph } of cases) {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="done"
          runtimeState="done"
          textScale="sidebar"
          pipelineStatus={pipelineStatus}
        />,
      );
      expect(html).not.toContain('data-glyph="circle-check"');
      expect(html).toContain(`data-testid="${glyph}"`);
      if (pipelineStatus === 'unseen' || pipelineStatus === 'unseen-failure') {
        expect(html).toContain('data-testid="worktree-row-pipeline-attention"');
      }
    }
  });

  it('hosts the pipeline popover on the unseen-result dot and paused shield', () => {
    // Unseen pipeline results resolve to the severity dot; the dot hosts the
    // pipeline popover.
    const unseenFailure = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        pipelineStatus="unseen-failure"
        textScale="sidebar"
        onPipelineIconMouseEnter={() => undefined}
      />,
    );
    expect(unseenFailure).toContain(
      'data-testid="worktree-row-pipeline-attention"',
    );
    expect(unseenFailure).toContain('aria-label="Pipeline failed"');
    expect(unseenFailure).toContain('tabindex="0"');

    // A paused pipeline without a chat plan renders the pipeline glyph,
    // which hosts the pipeline popover.
    const paused = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="planning"
        pipelineStatus="paused"
        textScale="sidebar"
        onPipelineIconMouseEnter={() => undefined}
      />,
    );
    expect(paused).toContain('data-testid="worktree-row-paused-pipeline"');
    expect(paused).toContain('aria-label="Pipeline paused"');
    expect(paused).toContain('tabindex="0"');

    // The failure dot outranks the unread dot when both are present.
    const both = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        hasUnread
        pipelineStatus="unseen-failure"
        textScale="sidebar"
        onUnreadIconMouseEnter={() => undefined}
      />,
    );
    expect(both).not.toContain('data-testid="worktree-row-unread"');
    expect(both).toContain('data-testid="worktree-row-pipeline-attention"');
  });

  it('renders classic idle as empty space instead of a dot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Idle"
        branchName="idle"
        uiStatus="idle"
        textScale="sidebar"
      />,
    );
    expect(html).toContain('data-testid="worktree-idle-status-placeholder"');
    expect(html).not.toContain('rounded-full bg-fg-');
  });

  it('spaces classic PR metadata and shows approval only for open PRs', () => {
    const open = renderToString(
      <WorktreeRow
        branchLabel="Open PR"
        branchName="open-pr"
        worktreeId="open-pr"
        uiStatus="idle"
        textScale="sidebar"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: true,
          label: 'PR #124',
        }}
      />,
    );
    const merged = renderToString(
      <WorktreeRow
        branchLabel="Merged PR"
        branchName="merged-pr"
        worktreeId="merged-pr"
        uiStatus="idle"
        textScale="sidebar"
        lastKnownPrStatus={{
          state: 'merged',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: false,
          label: 'PR #128',
        }}
      />,
    );

    expect(open).toContain('class="mx-1" aria-hidden="true">·</span>');
    expect(open).toContain('data-testid="worktree-row-pr-approved"');
    expect(open).toContain('fg-success');
    expect(open).not.toContain('text-emerald-400');
    expect(merged).not.toContain('data-testid="worktree-row-pr-approved"');
  });

  it('prefixes a nested branch subtitle with its primary-colored ancestry depth', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Nested child task"
        branchName="codex/group-child"
        worktreeId="group-child"
        uiStatus="idle"
        nested
        nestedChildDepth={2}
        textScale="sidebar"
      />,
    );

    // The depth number inherits the subtitle's metrics and color — same
    // font size, weight, and gray as the neighboring identity text.
    expect(html).toContain('data-testid="worktree-row-nested-child-depth"');
    expect(html).not.toMatch(
      /fg-primary[^>]*data-testid="worktree-row-nested-child-depth"/,
    );
    expect(html).toContain('·');
    expect(html).toContain('group-child');
  });

  it('aligns a nested leading icon with top-level sidebar items', () => {
    const nested = renderToString(
      <WorktreeRow
        branchLabel="Nested"
        branchName="nested"
        uiStatus="idle"
        nested
        textScale="sidebar"
      />,
    );
    const topLevel = renderToString(
      <WorktreeRow
        branchLabel="Top level"
        branchName="top-level"
        uiStatus="idle"
        textScale="sidebar"
      />,
    );

    expect(nested).toContain('-translate-x-3');
    expect(topLevel).not.toContain('-translate-x-3');
  });

  it('uses CSS ellipsis for constrained classic subtitle text', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Discovering"
        branchName="discovering"
        worktreeId="environment"
        uiStatus="idle"
        isDiscovering
        textScale="sidebar"
      />,
    );

    expect(html).toContain('block min-w-0 flex-1 truncate whitespace-nowrap');
    expect(html).toContain('Discovering environment…');
    expect(html).not.toContain('inline-flex items-center gap-1 fg-secondary');
  });

  it('renders the split status message in the classic subtitle', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/split-pr-review"
        branchName="feature/split-pr-review"
        worktreeId="demo-main"
        uiStatus="idle"
        splitStatus="review"
        splitStatusMessage="Waiting for your plan approval"
        textScale="sidebar"
        lastKnownPrStatus={{
          state: 'open',
          title: 'Split this pull request',
          description: 'Example description',
        }}
      />,
    );

    expect(html).toMatch(
      /data-testid="worktree-row-subtitle"[\s\S]*Waiting for your plan approval/,
    );
  });

  it('uses s title text with a 2xs subtitle in the sidebar', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/foo"
        branchName="feature/foo"
        uiStatus="working"
        textScale="sidebar"
        splitStatus="review"
        splitStatusMessage="Waiting for approval"
        diffStats={{ insertions: 2, deletions: 1 }}
        lastKnownPrStatus={{
          state: 'open',
          title: 'Example pull request',
          description: 'Example description',
        }}
      />,
    );
    expect(html).toContain('text-s');
    expect(html).toContain(
      'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-s',
    );
    expect(html).toContain('w-full min-w-0');
    expect(html).toContain('data-testid="worktree-row-subtitle"');
    expect(html).toContain('text-2xs');
    expect(html).toContain('fg-tertiary');
    expect(html).toContain('mt-0.5 flex h-4 min-w-0 items-center gap-1.5');
    expect(html).toContain('flex min-w-0 flex-1 items-center gap-1.5');
    expect(html).toContain('block min-w-0 flex-1 truncate');
    expect(html).toContain('min-w-0 flex-1 self-center');
    expect(html).toContain('px-1.5 py-1.5');
    expect(html).toContain('rounded-row');
    expect(html).toContain('group/sidebar-item');
    expect(html).toContain('fg-secondary hover:bg-subtle');
    expect(html).toContain('font-normal');
    expect(html).not.toContain('font-normal fg-primary');
    expect(html).not.toContain('font-normal fg-primary/80');
    expect(html).toContain('data-testid="worktree-row-pr-badge"');
    expect(html).toContain('·');
    // Classic keeps the trailing diff stats in the subtitle row.
    expect(html).toContain('data-testid="diff-stats-badge"');
    expect(html).not.toContain('text-m');
    expect(html).not.toContain('font-semibold');
    expect(html).not.toContain('font-bold');
  });

  it('keeps selected sidebar task text primary', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/selected"
        branchName="feature/selected"
        uiStatus="idle"
        textScale="sidebar"
        selected
      />,
    );

    expect(html).toContain('bg-muted fg-primary');
    expect(html).not.toContain('fg-secondary hover:bg-subtle');
  });

  it('renders no optional badges when all flags are undefined', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/foo"
        branchName="feature/foo"
        uiStatus="idle"
      />,
    );
    expect(html).not.toContain('worktree-row-pipeline-badge');
    expect(html).not.toContain('worktree-row-terminal-badge');
    expect(html).not.toContain('worktree-row-pr-badge');
    expect(html).not.toContain('worktree-row-shared-badge');
    expect(html).not.toContain('worktree-row-awaiting-approval');
    expect(html).not.toContain('worktree-row-unread');
    expect(html).not.toContain('worktree-row-watchers');
    expect(html).not.toContain('worktree-row-scheduled-messages');
    expect(html).not.toContain('Worktree issue');
    expect(html).not.toContain('data-testid="worktree-row-status-rail"');
    expect(html).not.toContain('self-center pr-7');
  });

  it('replaces the branch subtitle with the active status and keeps one loader on the right', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/foo"
        branchName="feature/foo"
        worktreeId="tiger"
        uiStatus="idle"
        isRunningRun
      />,
    );

    expect(html).toContain('title="Running"');
    expect(html).not.toContain('>tiger<');
    expect(html).toContain('aria-label="Running"');
    expect(html).toContain('data-testid="worktree-row-status-rail"');
    expect(html).toContain('absolute right-1 top-[calc(50%-0.5625rem)]');
    expect(html).not.toContain('fg-info');
  });

  it('keeps the pipeline icon neutral while the right rail owns status color', () => {
    const running = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="running"
      />,
    );
    expect(running).toContain('worktree-row-pipeline-badge');
    expect(running).not.toContain('fg-info');
    expect(running).toContain('Pipeline running');

    const failed = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="unseen-failure"
      />,
    );
    expect(failed).not.toContain('fg-destructive-strong');
    // The rail dot still carries the failure color; the badge inherits.
    expect(failed).toContain('fg-destructive');
    expect(failed).toContain('h-1.5 w-1.5 rounded-full bg-current');
    expect(failed).toContain('Pipeline failed');

    const unseen = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="unseen"
      />,
    );
    expect(unseen).not.toContain('fg-info');
    expect(unseen).toContain('fg-success');
    expect(unseen).not.toContain('fg-blue');

    const paused = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="paused"
      />,
    );
    expect(paused).toContain('Pipeline paused');
    expect(paused).not.toContain('fg-secondary');
  });

  it('colors failed terminal icons and status dots red', () => {
    const failed = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        terminalStatus="unseen-failure"
      />,
    );
    expect(failed).toMatch(
      /class="focus-ring shrink-0 rounded-sm outline-none"[^>]*data-testid="worktree-row-terminal-badge"/,
    );
    expect(failed).toContain('h-1.5 w-1.5 rounded-full bg-current');
    // The rail dot still carries the failure color; the badge inherits.
    expect(failed).toContain('fg-destructive');
    expect(failed).toContain('Terminal failed');

    const running = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        terminalStatus="running"
      />,
    );
    expect(running).toMatch(
      /class="focus-ring shrink-0 rounded-sm outline-none"[^>]*data-testid="worktree-row-terminal-badge"/,
    );
  });

  it('keeps a running terminal glyph neutral so it reads apart from a finished one', () => {
    // Running and unseen both sit on the info blue in the status rail; the
    // rail draws a spinner for one and a dot for the other. The glyph has no
    // shape cue, so only the finished result is tinted, like pipelines.
    const badgeClass = (terminalStatus: 'running' | 'unseen'): string => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          terminalStatus={terminalStatus}
          textScale="sidebar"
        />,
      );
      const match = html.match(
        /class="([^"]*)"[^>]*data-testid="worktree-row-terminal-badge"/,
      );
      return match?.[1] ?? '';
    };
    expect(badgeClass('running')).toContain('fg-secondary');
    expect(badgeClass('running')).not.toContain('fg-info');
    expect(badgeClass('unseen')).toContain('fg-info');
  });

  it('renders the script (rocket) badge when scriptStatus=running', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        scriptStatus="running"
      />,
    );
    expect(html).toContain('worktree-row-script-badge');
    expect(html).not.toContain('fg-info');
    expect(html).toContain('Scripts running');
  });

  it('renders the hook badge when hookStatus=running', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        hookStatus="running"
      />,
    );
    expect(html).toContain('worktree-row-hook-badge');
    expect(html).not.toContain('fg-info');
    expect(html).toContain('Hooks running');
  });

  it('renders no script or hook badge when the flags are undefined', () => {
    const html = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
    );
    expect(html).not.toContain('worktree-row-script-badge');
    expect(html).not.toContain('worktree-row-hook-badge');
  });

  it('renders the graph-build badge when graphBuildStatus=building', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        graphBuildStatus="building"
      />,
    );
    expect(html).toContain('worktree-row-graph-badge');
    expect(html).toContain('Updating project graph…');
  });

  it('uses distinct graph and pipeline glyphs when both badges are visible', () => {
    // Pipeline and graph now sit side by side in the subtitle strip, so
    // their glyphs must remain distinct (network node vs hub).
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        textScale="sidebar"
        pipelineStatus="running"
        graphBuildStatus="building"
      />,
    );

    expect(html).toContain('data-testid="worktree-row-working-pipeline"');
    expect(html).toContain('data-testid="worktree-row-graph-badge"');
    expect(html).toContain('data-glyph="workflow"');
    expect(html).toContain('data-glyph="network"');
  });

  it('renders no graph-build badge when graphBuildStatus is undefined', () => {
    const html = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
    );
    expect(html).not.toContain('worktree-row-graph-badge');
  });

  it('renders no split badge when splitStatus is undefined', () => {
    const html = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
    );
    expect(html).not.toContain('worktree-row-split-badge');
  });

  it('colors the active split icon blue and puts its activity loader in the right rail', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        splitStatus="active"
      />,
    );
    expect(html).toContain('worktree-row-split-badge');
    expect(html).toContain('data-split-status="active"');
    expect(html).not.toMatch(
      /class="[^"]*fg-blue[^"]*"[^>]*data-testid="worktree-row-split-badge"/,
    );
    expect(html).not.toContain('animate-pulse');
    expect(html).toContain('Split PR in progress');
    expect(html).toContain('data-testid="worktree-row-status-rail"');
    expect(html).toContain('aria-label="Loading"');
  });

  it('keeps the split review icon neutral and shows attention on the right', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        splitStatus="review"
      />,
    );
    expect(html).toContain('worktree-row-split-badge');
    expect(html).toContain('data-split-status="review"');
    expect(html).not.toMatch(
      /class="[^"]*fg-(blue|success|secondary)[^"]*"[^>]*data-testid="worktree-row-split-badge"/,
    );
    expect(html).not.toContain('animate-pulse');
    expect(html).toContain('Split PR awaiting plan approval');
  });

  it('colors the completed split icon green and shows attention on the right', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        splitStatus="done"
      />,
    );
    expect(html).toContain('worktree-row-split-badge');
    expect(html).toContain('data-split-status="done"');
    expect(html).not.toMatch(
      /class="[^"]*fg-success[^"]*"[^>]*data-testid="worktree-row-split-badge"/,
    );
    expect(html).not.toContain('animate-pulse');
    expect(html).toContain('Split PR complete');
  });

  it('renders the awaiting-approval marker when awaitingApproval is true', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="planning"
        awaitingApproval
      />,
    );
    expect(html).toContain('worktree-row-awaiting-approval');
    expect(html).toContain('Review plan');
  });

  it('renders a paused pipeline as the orange pipeline icon, not the shield', () => {
    // The shield glyph means "review plan"; a paused pipeline gets the
    // pipeline glyph in the needs-input orange (waiting on the user).
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="planning"
        textScale="sidebar"
        pipelineStatus="paused"
      />,
    );
    expect(html).toContain('data-testid="worktree-row-paused-pipeline"');
    expect(html).toContain('aria-label="Pipeline paused"');
    expect(html).not.toContain('data-testid="worktree-row-planning-approval"');
    expect(html).toMatch(/fg-warning[^>]*>\s*<svg[^>]*data-app-icon/);
    expect(html).not.toContain('fg-orange');
  });

  it('reserves a fixed trailing status slot only while occupied', () => {
    // Each chat-state badge keeps a h-5 w-5 footprint whose height matches
    // the title's 20px line, so row height and the title↔subtitle gap never
    // shift between states; an EMPTY cluster is not rendered so it never
    // steals title width. The cluster grows leftward as states stack, and
    // it stays VISIBLE while the row is hovered: the label line's chip
    // reserve pushes the cluster left so it sits beside the revealed action
    // buttons instead of hiding under them.
    const slotClass =
      'inline-flex h-5 shrink-0 items-center justify-end gap-0.5 -mr-0.5';
    const idle = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        textScale="sidebar"
      />,
    );
    expect(idle).not.toContain('data-testid="worktree-row-trailing-slot"');
    // The label line is height-pinned to the slot size, so slot presence
    // never changes the row height.
    expect(idle).toContain('flex min-h-5 items-center gap-1');

    const unread = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        hasUnread
        textScale="sidebar"
      />,
    );
    const unreadSlotIndex = unread.indexOf(
      'data-testid="worktree-row-trailing-slot"',
    );
    expect(unreadSlotIndex).toBeGreaterThan(-1);
    expect(unread).toContain(slotClass);
    // The cluster is never hover-hidden — indicators stay visible next to
    // the action buttons.
    expect(unread).not.toContain('pointer-fine:group-hover:hidden');
    // The dot renders inside the slot.
    expect(unread.indexOf('data-testid="worktree-row-unread"')).toBeGreaterThan(
      unreadSlotIndex,
    );

    const streaming = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        isStreaming
        textScale="sidebar"
      />,
    );
    const streamingSlotIndex = streaming.indexOf(
      'data-testid="worktree-row-trailing-slot"',
    );
    expect(streamingSlotIndex).toBeGreaterThan(-1);
    expect(
      streaming.indexOf('data-testid="worktree-row-classic-streaming-spinner"'),
    ).toBeGreaterThan(streamingSlotIndex);
  });

  it('renders setup-phase loaders in the trailing slot, not leading', () => {
    // Every loader/spinner lives on the RIGHT: setup, teardown, and
    // git-pending loaders render inside the fixed trailing slot like the
    // streaming spinner, leaving the leading slot to glyph states.
    for (const setupPhase of [
      'running-setup',
      'running-teardown',
      'git-pending',
    ] as const) {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          setupPhase={setupPhase}
        />,
      );
      const slotIndex = html.indexOf(
        'data-testid="worktree-row-trailing-slot"',
      );
      const loaderIndex = html.indexOf('fg-accent');
      expect(slotIndex).toBeGreaterThan(-1);
      expect(loaderIndex).toBeGreaterThan(slotIndex);
      // The leading slot holds only the idle placeholder.
      expect(html).toContain('data-testid="worktree-idle-status-placeholder"');
    }
  });

  it('renders the orange question dot when a question is pending (classic)', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        textScale="sidebar"
        hasUnread
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question"');
    expect(html).toContain('Question waiting');
    expect(html).toContain('bg-fg-warning');
    // Needs-input outranks unread: the orange dot takes the single dot slot
    // and renders on the RIGHT side of the label line.
    expect(html).not.toContain('data-testid="worktree-row-unread"');
    expect(html.indexOf('data-testid="worktree-row-question"')).toBeGreaterThan(
      html.indexOf('<p title="b"'),
    );
  });

  it('keeps the compact question dot visible while another tab streams', () => {
    // Question chats are excluded from the streaming derivation, so
    // isStreaming here means a DIFFERENT tab is working — the question still
    // needs the user and must not be hidden behind the streaming loader.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        isStreaming
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question"');
  });

  it('renders the orange question dot in the compact (non-sidebar) layout', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        hasUnread
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question"');
    expect(html).toContain('Question waiting');
    expect(html).toContain('fg-warning');
    expect(html).not.toContain('data-testid="worktree-row-unread"');
  });

  it('renders the question label with an inline orange dot on kanban cards', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="calm-otter"
        uiStatus="unread"
        displayMode="kanban"
        hasUnread
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question-label"');
    expect(html).toContain('Question waiting');
    expect(html).toContain('bg-fg-warning');
    expect(html).not.toContain('>Unread<');
  });

  it('shows the question glyph over the plan shield with the dot trailing', () => {
    // Leading (glyph) and trailing (dot) are independent slots — a row can
    // await plan approval and carry a pending question at the same time. In
    // the finalized chain the question glyph outranks the shield.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        textScale="sidebar"
        awaitingApproval
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question-glyph"');
    expect(html).not.toContain('data-testid="worktree-row-awaiting-approval"');
    expect(html).toContain('data-testid="worktree-row-question"');
    // Question glyph leads (before the label), question dot trails (after).
    expect(
      html.indexOf('data-testid="worktree-row-question-glyph"'),
    ).toBeLessThan(html.indexOf('<p title="b"'));
    expect(html.indexOf('data-testid="worktree-row-question"')).toBeGreaterThan(
      html.indexOf('<p title="b"'),
    );
  });

  it('shows the classic question dot alongside the streaming spinner', () => {
    // A turn blocked on an interactive question is user-actionable, and a
    // different chat may be streaming at the same time — both stay visible,
    // the dot in the anchor (right-most) slot.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="working"
        textScale="sidebar"
        isStreaming
        hasPendingQuestion
      />,
    );
    expect(html).toContain('data-testid="worktree-row-question"');
    expect(html).toContain(
      'data-testid="worktree-row-classic-streaming-spinner"',
    );
    expect(
      html.indexOf('data-testid="worktree-row-classic-streaming-spinner"'),
    ).toBeLessThan(html.indexOf('data-testid="worktree-row-question"'));
  });

  it('keeps attention dots and the working spinner alive on a done row', () => {
    // Done no longer mutes the trailing cluster: a waiting question keeps its
    // orange dot, unread chats keep the blue dot, and a streaming chat keeps
    // the working spinner. The checkmark is only the quiet-state fallback.
    const question = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        textScale="sidebar"
        hasPendingQuestion
      />,
    );
    expect(question).toContain('data-testid="worktree-row-question"');

    const unread = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        textScale="sidebar"
        hasUnread
      />,
    );
    expect(unread).toContain('data-testid="worktree-row-unread"');
    // Unread carries a trailing dot, not a leading glyph, so the quiet
    // leading slot still falls back to the done checkmark.
    expect(unread).toContain('data-glyph="circle-check"');

    const streaming = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        textScale="sidebar"
        isStreaming
      />,
    );
    expect(streaming).toContain(
      'data-testid="worktree-row-classic-streaming-spinner"',
    );
  });

  it('renders the unread marker when hasUnread is true and not done', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="unread"
        hasUnread
      />,
    );
    expect(html).toContain('worktree-row-unread');
    expect(html).toContain('Unread messages');
    expect(html).toContain('fg-blue');
    expect(html).toContain('h-1.5 w-1.5 rounded-full bg-current');
    expect(html).not.toContain('border-fg-info');
  });

  it('renders scheduled messages as the same solid attention dot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        hasScheduledMessages
      />,
    );
    expect(html).toContain('worktree-row-scheduled-messages');
    expect(html).toContain('Scheduled messages');
    expect(html).toContain('fg-blue');
    expect(html).toContain('h-1.5 w-1.5 rounded-full bg-current');
    expect(html).not.toContain('border-status');
  });

  it('renders the broadcast icon for idle chats with watchers', () => {
    const compact = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        hasIdleWatcherChats
      />,
    );
    const classic = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        textScale="sidebar"
        hasIdleWatcherChats
      />,
    );

    expect(compact).toContain('data-testid="worktree-row-watchers"');
    expect(compact).toContain('aria-label="Chats with watchers"');
    expect(compact).toContain('data-testid="worktree-row-status-rail"');
    expect(classic).toContain('data-testid="worktree-row-watchers"');
    expect(classic).not.toContain('text-sky-400');
    // With no higher-priority leading indicator, classic promotes the
    // watcher icon into the 16px leading slot.
    expect(classic).toContain('width="14px"');
    expect(classic.indexOf('data-testid="worktree-row-watchers"')).toBeLessThan(
      classic.indexOf('<p title="b"'),
    );
  });

  it('renders discovery as an accessible right-rail status', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        worktreeId="kiwi"
        isDiscovering
      />,
    );
    expect(html).toContain('aria-label="Discovering environment"');
    expect(html).toContain('data-testid="worktree-row-status-rail"');
    expect(html).not.toContain('Discovering environment...');
  });

  it('hides attention markers when runtimeState=done', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        hasUnread
        hasIdleWatcherChats
        awaitingApproval
        hasScheduledMessages
        runtimeState="done"
      />,
    );
    expect(html).not.toContain('worktree-row-unread');
    expect(html).not.toContain('worktree-row-awaiting-approval');
    expect(html).not.toContain('worktree-row-watchers');
    expect(html).not.toContain('worktree-row-scheduled-messages');
    expect(html).toContain('Done');
  });

  it('keeps the classic subtitle full-width under the hover action reserve', () => {
    // Fine-pointer hover chips overlay only the label line, so the hover
    // padding reserve must live on the label row — not the two-line wrapper —
    // or the subtitle truncates under space it never cedes to anything.
    const html = renderToString(
      <WorktreeRow
        branchLabel="Reserve"
        branchName="reserve"
        uiStatus="idle"
        textScale="sidebar"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
        actionChipButtonCount={2}
      />,
    );
    const wrapperMatch = html.match(/class="min-w-0 flex-1 self-center[^"]*"/);
    expect(wrapperMatch).not.toBeNull();
    expect(wrapperMatch?.[0]).not.toContain('pointer-fine:group-hover');
    // The reserve still exists — on the label line.
    expect(html).toContain('pointer-fine:group-hover:pr-13.5');
    // Coarse pointers center the chip over both lines, so that reserve stays
    // on the wrapper.
    expect(wrapperMatch?.[0]).toContain('pointer-coarse:pr-12');
  });

  it('keeps the health warning as a warning-tinted subtitle icon', () => {
    // The warning never takes the classic leading slot — the leading
    // indicators keep their single-state vocabulary, and the subtitle
    // triangle (tinted fg-warning so it reads as a warning) carries broken
    // state alongside any of them.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        textScale="sidebar"
        healthIssue={{ status: 'broken', reason: 'Worktree missing on disk' }}
      />,
    );
    expect(html).not.toContain('data-testid="worktree-row-health-warning"');
    // The reason lives in the rich hover tooltip (portaled on hover/focus,
    // see WorktreeRow.focus.test.tsx), not in a native `title` (CAN-2799).
    expect(html).not.toMatch(
      /<button[^>]*title=[^>]*aria-label="Worktree issue - click for details"/,
    );
    expect(html).not.toContain('title="Worktree missing on disk"');
    // Subtitle hosts it, after the leading slot.
    expect(html.indexOf('data-testid="worktree-row-subtitle"')).toBeLessThan(
      html.indexOf('aria-label="Worktree issue - click for details"'),
    );
    expect(html).toMatch(
      /class="[^"]*fg-warning[^"]*"[^>]*aria-label="Worktree issue - click for details"/,
    );
    // The click padding is cancelled by a negative margin so the glyph sits
    // exactly in the shared subtitle icon column (plain-span badges have no
    // padding).
    expect(html).toMatch(
      /class="[^"]*-m-0\.5 p-0\.5[^"]*"[^>]*aria-label="Worktree issue - click for details"/,
    );
    expect(
      html.match(/aria-label="Worktree issue - click for details"/g),
    ).toHaveLength(1);
  });

  it('shows the subtitle warning alongside every leading indicator', () => {
    const cases = [
      { uiStatus: 'planning', awaitingApproval: true },
      { uiStatus: 'idle', hasPendingQuestion: true },
      { uiStatus: 'done', runtimeState: 'done' },
    ] as const;
    for (const extra of cases) {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          textScale="sidebar"
          healthIssue={{ status: 'broken', reason: 'broken checkout' }}
          {...extra}
        />,
      );
      expect(html).not.toContain('data-testid="worktree-row-health-warning"');
      expect(html).toContain('aria-label="Worktree issue - click for details"');
    }
  });

  it('renders the warning icon when healthIssue.status=broken', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        healthIssue={{ status: 'broken', reason: 'Worktree missing on disk' }}
      />,
    );
    expect(html).toContain('Worktree issue');
    expect(html).toContain('Worktree missing on disk');
    expect(html).toContain('data-glyph="triangle-alert"');
    expect(html).toContain('fg-destructive');
    expect(html).toContain('fg-warning');
    expect(html).not.toContain('text-amber-400');
  });

  it('renders the warning icon when hasMismatch is true', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        hasMismatch
      />,
    );
    expect(html).toContain('Worktree issue');
  });

  it.each(['git-pending', 'running-setup'] as const)(
    'does not render health or mismatch warnings while setupPhase=%s',
    (setupPhase) => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          setupPhase={setupPhase}
          healthIssue={{ status: 'broken', reason: 'Transient setup state' }}
          hasMismatch
        />,
      );
      expect(html).not.toContain('Worktree issue');
      expect(html).not.toContain('Transient setup state');
    },
  );

  it('renders the PR badge as a link when url is set', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/pr-link"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          url: 'https://example.com/pr/1',
          label: 'PR #1',
        }}
      />,
    );
    expect(html).toContain('worktree-row-pr-badge');
    expect(html).toContain('href="https://example.com/pr/1"');
    expect(html).toContain('PR #1');
    expect(html).toContain('data-testid="worktree-row-subtitle-separator"');
    expect(html).toContain('data-testid="worktree-row-pr-icon"');
    expect(html).toContain('data-testid="worktree-row-pr-label"');
    expect(html).toContain('data-app-icon="true"');
    expect(html).toContain('width="16px"');
    expect(html.indexOf('worktree-row-pr-icon')).toBeLessThan(
      html.indexOf('worktree-row-subtitle'),
    );
    expect(html).toMatch(
      /class="[^"]*\bfg-tertiary\b[^"]*" data-testid="worktree-row-pr-label"/,
    );
    expect(html).toContain('fg-secondary');
    expect(html).not.toContain('fg-success-strong');
  });

  it('renders the default PR-creating indicator when isCreatingPr and no slot is provided', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        isCreatingPr
      />,
    );
    expect(html).toContain('Creating PR');
    expect(html).toContain('aria-label="Creating pull request"');
    expect(html).toContain('aria-label="Loading"');
  });

  it('renders the creating slot in place of the default indicator when provided', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        isCreatingPr
        prCreatingSlot={<span data-testid="creating-tooltip">creating</span>}
      />,
    );
    expect(html).toContain('creating-tooltip');
    // The default inline "Loading" spinner is replaced by the slot.
    expect(html).not.toContain('aria-label="Loading"');
  });

  it('places the classic PR-creating spinner immediately after the PR label', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="classic-pr"
        uiStatus="idle"
        textScale="sidebar"
        isCreatingPr
        prCreatingSlot={<span data-testid="creating-tooltip">creating</span>}
      />,
    );

    expect(html.indexOf('>PR</span>')).toBeLessThan(
      html.indexOf('creating-tooltip'),
    );
  });

  it('does not render the creating slot when isCreatingPr is false', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        prCreatingSlot={<span data-testid="creating-tooltip">creating</span>}
      />,
    );
    expect(html).not.toContain('creating-tooltip');
  });

  it('renders the merging slot next to the PR badge while a PR merge is in flight', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          label: 'PR #1',
        }}
        prMergingSlot={<span data-testid="merge-spinner">merging</span>}
      />,
    );
    expect(html).toContain('worktree-row-pr-badge');
    expect(html).toContain('merge-spinner');
  });

  it('places the classic merging spinner after the PR label and approval checkmark', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="classic-pr-merge"
        uiStatus="idle"
        textScale="sidebar"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: true,
          label: 'PR #1',
        }}
        prMergingSlot={<span data-testid="merge-spinner">merging</span>}
      />,
    );

    expect(html.indexOf('worktree-row-pr-label')).toBeLessThan(
      html.indexOf('worktree-row-pr-approved'),
    );
    expect(html.indexOf('worktree-row-pr-approved')).toBeLessThan(
      html.indexOf('merge-spinner'),
    );
  });

  it('keeps the classic merging spinner inside the PR label flex line so it stays vertically centered', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="classic-pr-merge-centering"
        uiStatus="idle"
        textScale="sidebar"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          label: 'PR #1',
        }}
        prMergingSlot={<span data-testid="merge-spinner">merging</span>}
      />,
    );

    // As a standalone inline sibling the spinner baseline-aligns against the
    // subtitle text and hangs ~7px low. It must stay a flex item on the same
    // centered line as the PR label (the group fills the 16px line box).
    const group = html.indexOf(
      'class="inline-flex h-4 items-center gap-1 align-bottom"',
    );
    expect(group).toBeGreaterThan(-1);
    expect(group).toBeLessThan(html.indexOf('worktree-row-pr-badge'));
    expect(html.indexOf('worktree-row-pr-label')).toBeLessThan(
      html.indexOf('merge-spinner'),
    );
    expect(html).not.toContain('ml-1 inline-flex shrink-0 items-center');
  });

  it('omits the merging slot when there is no PR badge (done row)', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        lastKnownPrStatus={{
          state: 'merged',
          checkStatus: 'passing',
          label: 'PR #1',
        }}
        prMergingSlot={<span data-testid="merge-spinner">merging</span>}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-badge');
    expect(html).not.toContain('merge-spinner');
  });

  it('does not show a right dot for an approved PR', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: true,
          label: 'PR #1',
        }}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-approved');
    expect(html).not.toContain('worktree-idle-status-placeholder');
    expect(html).not.toContain('fg-success');
    expect(html).not.toContain('h-1.5 w-1.5 rounded-full bg-current');
    expect(html).not.toContain('data-testid="worktree-row-status-rail"');
  });

  it('keeps approved PRs dot-free when merge readiness is not provided', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          label: 'PR #1',
        }}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-approved');
    expect(html).not.toContain('worktree-idle-status-placeholder');
    expect(html).not.toContain('fg-success');
    expect(html).not.toContain('h-1.5 w-1.5 rounded-full bg-current');
  });

  it('does not show a paused dot when the PR is approved but not mergeable', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: false,
          label: 'PR #1',
        }}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-approved');
    expect(html).not.toContain('worktree-idle-status-placeholder');
    expect(html).not.toContain('h-1.5 w-1.5 rounded-full bg-current');
  });

  it('does not show a dot for an approved PR with unresolved comments', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: true,
          unresolvedCommentCount: 2,
          label: 'PR #1',
        }}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-approved');
    expect(html).not.toContain('worktree-idle-status-placeholder');
    expect(html).not.toContain('h-1.5 w-1.5 rounded-full bg-current');
  });

  it('uses a loader instead of a dot while PR checks are running', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'draft',
          checkStatus: 'none',
          ciStatus: 'pending',
          label: 'PR #1',
        }}
      />,
    );

    expect(html).toContain('aria-label="Pull request checks running"');
    expect(html).toContain('aria-label="Loading"');
    expect(html).not.toContain('h-1.5 w-1.5 rounded-full bg-current');
  });

  it('does not render the approved marker for non-approved PR review states', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'pending',
          label: 'PR #1',
        }}
      />,
    );
    expect(html).not.toContain('worktree-row-pr-approved');
  });

  it('renders the PR badge with failure tint when check is failing', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'failing',
          label: 'PR #2',
        }}
      />,
    );
    expect(html).toContain('fg-destructive');
    expect(html).toContain('aria-label="Pull request needs attention"');
    expect(html).toContain('h-1.5 w-1.5 rounded-full bg-current');
    expect(html).toContain('data-pr-icon="failing"');
    expect(html).toMatch(
      /class="[^"]*fg-destructive[^"]*"[^>]*data-testid="worktree-row-pr-icon"/,
    );
    expect(html).toMatch(
      /class="[^"]*\bfg-tertiary\b[^"]*" data-testid="worktree-row-pr-label"/,
    );
    expect(html).not.toContain('fg-destructive-strong');
  });

  it.each([
    ['open', 'fg-secondary', 'pull-request'],
    ['draft', 'fg-secondary', 'draft'],
    ['closed', 'fg-destructive', 'closed'],
    ['merged', 'fg-purple', 'merged'],
  ] as const)(
    'renders the PR badge for state=%s with %s and the compact %s icon',
    (state, colorClass, iconKind) => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          lastKnownPrStatus={{
            state,
            checkStatus: 'neutral',
            label: `PR ${state}`,
          }}
        />,
      );
      expect(html).toContain(`PR ${state}`);
      expect(html).toContain(colorClass);
      expect(html).toContain(`data-pr-icon="${iconKind}"`);
      expect(html).toMatch(
        new RegExp(
          `class="[^"]*${colorClass}[^"]*"[^>]*data-testid="worktree-row-pr-icon"`,
        ),
      );
      expect(html).toMatch(
        /class="[^"]*\bfg-tertiary\b[^"]*" data-testid="worktree-row-pr-label"/,
      );
    },
  );

  it('colors a conflicting PR badge destructively', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        lastKnownPrStatus={{
          state: 'open',
          checkStatus: 'passing',
          hasConflicts: true,
          label: 'PR conflict',
        }}
      />,
    );

    expect(html).toContain('PR conflict');
    expect(html).toContain('fg-destructive');
    expect(html).toContain('data-pr-icon="merge-conflict"');
  });

  describe('PR state Octicons', () => {
    const renderRow = (status: WorktreeRowPrStatus): string =>
      renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          lastKnownPrStatus={{ label: 'PR #7', ...status }}
        />,
      );
    // Every glyph assertion is scoped to the row's PR state and its colour.
    const prIcon = (kind: string, color: string, glyph: string): RegExp =>
      new RegExp(
        `class="[^"]*\\b${color}\\b[^"]*"[^>]*data-pr-icon="${kind}"><svg[^>]*data-glyph="${glyph}"`,
      );

    it('renders the merge-queue Octicon for a queued PR', () => {
      const html = renderRow({
        state: 'open',
        checkStatus: 'passing',
        inMergeQueue: true,
      });

      expect(html).toMatch(
        prIcon('merge-queue', 'fg-warning', 'git-merge-queue'),
      );
    });

    it('renders the alert Octicon in the destructive colour for a conflict', () => {
      const html = renderRow({
        state: 'open',
        checkStatus: 'passing',
        hasConflicts: true,
      });

      expect(html).toMatch(prIcon('merge-conflict', 'fg-destructive', 'alert'));
    });

    it('renders the merge Octicon in the purple colour once merged', () => {
      const html = renderRow({ state: 'merged', checkStatus: 'passing' });

      expect(html).toMatch(prIcon('merged', 'fg-purple', 'git-merge'));
    });

    // The badge's accessible name carries the state its glyph draws.
    it.each<[string, WorktreeRowPrStatus, string]>([
      [
        'a conflict',
        { state: 'open', checkStatus: 'passing', hasConflicts: true },
        'PR #7, has merge conflicts',
      ],
      [
        'an approved conflict',
        {
          state: 'open',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          hasConflicts: true,
        },
        'PR #7, has merge conflicts',
      ],
      [
        'a merged PR',
        { state: 'merged', checkStatus: 'passing', reviewStatus: 'approved' },
        'PR #7, merged',
      ],
    ])('names the state in the badge label for %s', (_, status, label) => {
      expect(renderRow(status)).toMatch(
        new RegExp(`aria-label="${label}"[^>]*data-pr-icon=`),
      );
    });

    it('renders the merge-queue Octicon on the sidebar queue chip', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          lastKnownPrStatus={{
            state: 'open',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            inMergeQueue: true,
            label: 'PR #7',
          }}
        />,
      );

      expect(html).toMatch(
        /data-testid="worktree-row-pr-merge-queue"><svg[^>]*data-glyph="git-merge-queue"/,
      );
    });
  });

  describe('merge queue', () => {
    const renderRow = (status: WorktreeRowPrStatus): string =>
      renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          lastKnownPrStatus={{ label: 'PR #7', ...status }}
        />,
      );

    it('shows the queued glyph with the pending tint and a position label', () => {
      const html = renderRow({
        state: 'open',
        checkStatus: 'passing',
        reviewStatus: 'approved',
        inMergeQueue: true,
        mergeQueuePosition: 3,
      });

      expect(html).toContain('data-pr-icon="merge-queue"');
      expect(html).toMatch(
        /class="[^"]*fg-warning[^"]*"[^>]*aria-label="In merge queue, position 3"[^>]*data-testid="worktree-row-pr-icon"/,
      );
    });

    it('omits the position from the label when GitHub reports none', () => {
      const html = renderRow({
        state: 'open',
        checkStatus: 'pending',
        inMergeQueue: true,
      });

      expect(html).toContain('data-pr-icon="merge-queue"');
      expect(html).toContain('aria-label="In merge queue"');
    });

    it('ranks merge conflicts above the queued state', () => {
      const html = renderRow({
        state: 'open',
        checkStatus: 'passing',
        hasConflicts: true,
        inMergeQueue: true,
      });

      expect(html).toContain('data-pr-icon="merge-conflict"');
      expect(html).not.toContain('In merge queue');
    });

    it('swaps the classic approval check for the queue glyph in the sidebar', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          lastKnownPrStatus={{
            state: 'open',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            isMergeReady: false,
            inMergeQueue: true,
            mergeQueuePosition: 1,
            label: 'PR #7',
          }}
        />,
      );

      expect(html).toMatch(
        /class="[^"]*fg-warning[^"]*"[^>]*data-testid="worktree-row-pr-badge"/,
      );
      expect(html).toMatch(
        /aria-label="In merge queue, position 1"[^>]*data-testid="worktree-row-pr-merge-queue"/,
      );
      expect(html).not.toContain('worktree-row-pr-approved');
      expect(html.indexOf('worktree-row-pr-label')).toBeLessThan(
        html.indexOf('worktree-row-pr-merge-queue'),
      );
    });

    it('keeps the classic approval check when the PR is not queued', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          textScale="sidebar"
          lastKnownPrStatus={{
            state: 'open',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            isMergeReady: true,
            inMergeQueue: false,
            label: 'PR #7',
          }}
        />,
      );

      expect(html).toContain('worktree-row-pr-approved');
      expect(html).not.toContain('worktree-row-pr-merge-queue');
    });

    it('ignores a stale queued flag once the PR has merged', () => {
      const html = renderRow({
        state: 'merged',
        checkStatus: 'passing',
        inMergeQueue: true,
      });

      expect(html).toContain('data-pr-icon="merged"');
      expect(html).not.toContain('In merge queue');
    });

    describe('tooltip phase line', () => {
      const queuedPr: WorktreeRowPrStatus = {
        state: 'open',
        checkStatus: 'passing',
        ciStatus: 'passing',
        reviewStatus: 'approved',
        inMergeQueue: true,
        mergeQueuePosition: 2,
        label: 'PR #7',
      };
      const renderTooltip = (status: WorktreeRowPrStatus): string =>
        renderToString(<PrBadgeTooltipContent pr={status} />);
      const textOf = (html: string): string =>
        html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");
      const phaseLine = (html: string): string | undefined => {
        const match =
          /<div data-testid="pr-tooltip-merge-queue-phase">(.*?)<\/div>/.exec(
            html,
          );
        return match ? textOf(match[1]) : undefined;
      };

      const phaseCases: Array<[WorktreeRowMergeQueuePhase, string]> = [
        ['queued', 'Queue: Waiting in queue'],
        ['awaiting_checks', 'Queue: Awaiting queue checks'],
        ['mergeable', 'Queue: Queue checks passed'],
        ['locked', 'Queue: Locked for merge'],
        ['unmergeable', "Queue: Can't merge from queue"],
      ];

      it.each(phaseCases)(
        'adds the %s phase after the queue line',
        (phase, expected) => {
          const html = renderTooltip({ ...queuedPr, mergeQueuePhase: phase });

          expect(phaseLine(html)).toBe(expected);
          expect(html).toContain('In merge queue (#2)');
          expect(html.indexOf('pr-tooltip-merge-queue"')).toBeLessThan(
            html.indexOf('pr-tooltip-merge-queue-phase'),
          );
          expect(textOf(html)).not.toMatch(/merged/i);
          // CI checks stay the PR's own checks, not the queue's.
          expect(textOf(html)).toContain('CI checks: Passing');
        },
      );

      it('tints only the unmergeable phase as a warning', () => {
        expect(
          renderTooltip({ ...queuedPr, mergeQueuePhase: 'unmergeable' }),
        ).toMatch(
          /pr-tooltip-merge-queue-phase">.*<span class="fg-warning">Can(&#x27;|')t merge from queue<\/span>/,
        );
        expect(
          renderTooltip({ ...queuedPr, mergeQueuePhase: 'mergeable' }),
        ).not.toMatch(/pr-tooltip-merge-queue-phase">.*fg-warning/);
      });

      it.each<[string, WorktreeRowMergeQueuePhase | undefined]>([
        ['unknown', 'unknown'],
        ['absent', undefined],
      ])('omits the phase line when the phase is %s', (_name, phase) => {
        const html = renderTooltip(
          phase === undefined
            ? queuedPr
            : { ...queuedPr, mergeQueuePhase: phase },
        );

        expect(html).toContain('data-testid="pr-tooltip-merge-queue"');
        expect(html).toContain('In merge queue (#2)');
        expect(html).not.toContain('pr-tooltip-merge-queue-phase');
      });

      it('omits the queue lines once the PR is no longer open', () => {
        const html = renderTooltip({
          ...queuedPr,
          state: 'merged',
          mergeQueuePhase: 'mergeable',
        });

        expect(html).not.toContain('pr-tooltip-merge-queue');
      });

      it('keeps the glyph accessible name unchanged when a phase is set', () => {
        const html = renderToString(
          <WorktreeRow
            branchLabel="b"
            branchName="b"
            uiStatus="idle"
            textScale="sidebar"
            lastKnownPrStatus={{
              ...queuedPr,
              mergeQueuePhase: 'awaiting_checks',
            }}
          />,
        );

        expect(html).toMatch(
          /aria-label="In merge queue, position 2"[^>]*data-testid="worktree-row-pr-merge-queue"/,
        );
        expect(renderRow({ ...queuedPr, mergeQueuePhase: 'locked' })).toMatch(
          /class="[^"]*fg-warning[^"]*"[^>]*aria-label="In merge queue, position 2"[^>]*data-testid="worktree-row-pr-icon"/,
        );
      });
    });
  });

  const prIconCases: Array<[string, WorktreeRowPrStatus, string]> = [
    ['healthy open', { state: 'open', checkStatus: 'passing' }, 'passing'],
    ['neutral open', { state: 'open', checkStatus: 'neutral' }, 'pull-request'],
    ['pending open', { state: 'open', checkStatus: 'pending' }, 'pull-request'],
    [
      'requested changes',
      {
        state: 'open',
        checkStatus: 'passing',
        reviewStatus: 'changes_requested',
      },
      'failing',
    ],
  ];

  it.each(prIconCases)(
    'uses the expected compact PR icon for %s',
    (_description, status, iconKind) => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          lastKnownPrStatus={{
            ...status,
            label: 'PR status',
          }}
        />,
      );

      expect(html).toContain(`data-pr-icon="${iconKind}"`);
    },
  );

  it('uses distinct compact icons for semantic PR lifecycle states', () => {
    const renderPrIcon = (status: WorktreeRowPrStatus): string => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="b"
          branchName="b"
          uiStatus="idle"
          lastKnownPrStatus={{ ...status, label: 'PR status' }}
        />,
      );
      return (
        html.match(
          /data-testid="worktree-row-pr-icon"[^>]*>([\s\S]*?)<\/span>/,
        )?.[1] ?? ''
      );
    };

    const passing = renderPrIcon({
      state: 'open',
      checkStatus: 'passing',
    });
    const neutral = renderPrIcon({
      state: 'open',
      checkStatus: 'neutral',
    });
    const failing = renderPrIcon({
      state: 'open',
      checkStatus: 'failing',
    });
    const closed = renderPrIcon({
      state: 'closed',
      checkStatus: 'none',
    });
    const conflict = renderPrIcon({
      state: 'open',
      checkStatus: 'passing',
      hasConflicts: true,
    });
    const draft = renderPrIcon({
      state: 'draft',
      checkStatus: 'neutral',
    });
    const merged = renderPrIcon({
      state: 'merged',
      checkStatus: 'passing',
    });

    expect(passing).not.toBe('');
    expect(neutral).not.toBe('');
    expect(failing).not.toBe('');
    expect(closed).not.toBe('');
    expect(conflict).not.toBe('');
    expect(draft).not.toBe('');
    expect(merged).not.toBe('');
    expect(passing).not.toBe(neutral);
    expect(failing).toBe(closed);
    expect(draft).not.toBe(passing);
    expect(merged).not.toBe(passing);
    expect(conflict).not.toBe(passing);
  });

  it('hides the PR badge when runtimeState=done and shows the done label instead', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        lastKnownPrStatus={{
          state: 'merged',
          checkStatus: 'passing',
          label: 'PR #3',
        }}
      />,
    );
    expect(html).toContain('Done');
    expect(html).not.toContain('worktree-row-pr-badge');
  });

  it('uses a caller-provided done label for merged PR worktrees', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        doneLabel="PR merged"
      />,
    );
    expect(html).toContain('PR merged');
    expect(html).toContain('aria-label="PR merged"');
    expect(html).toContain('fg-purple');
    expect(html).toContain('h-1.5 w-1.5 rounded-full bg-current');
  });

  it('shows the running-setup label when setupPhase=running-setup', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="running-setup"
      />,
    );
    expect(html).toContain('Running setup');
  });

  it('shows the running-teardown label when setupPhase=running-teardown', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="running-teardown"
      />,
    );
    expect(html).toContain('Running teardown');
  });

  // REG-3022 C7: a cloud worktree's archive runs as a server job. It reads
  // as archiving, never as the desktop's "Deleting worktree…" teardown, which
  // keeps its own copy.
  it('says archiving, not deleting or teardown, while setupPhase=running-archive', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="running-archive"
        textScale="sidebar"
      />,
    );
    expect(html).toContain('Archiving worktree…');
    expect(html).not.toContain('Deleting worktree…');
    expect(html).not.toContain('Running teardown');
    const desktop = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="running-teardown"
        textScale="sidebar"
      />,
    );
    expect(desktop).toContain('Deleting worktree…');
    expect(desktop).not.toContain('Archiving worktree…');
  });

  it('keeps the teardown loader fully opaque while fading disabled row content', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/teardown"
        uiStatus="idle"
        setupPhase="running-teardown"
        textScale="sidebar"
        isTearingDownVisual
      />,
    );

    expect(html).toContain('pointer-events-none');
    expect(html).toContain('min-w-0 flex-1 self-center opacity-50');
    // The teardown loader lives in the leading slot and stays opaque.
    expect(html).toContain('Deleting worktree…');
    expect(html).not.toContain('data-testid="worktree-row-status-rail"');
    expect(html).not.toContain('pointer-events-none opacity-50');
  });

  it('shows the git-pending label when setupPhase=git-pending', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        setupPhase="git-pending"
      />,
    );
    expect(html).toContain('Setting up');
  });

  it('renders the diff stats badge when diffStats is supplied with positive numbers', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/diff-stats"
        uiStatus="idle"
        diffStats={{ insertions: 42, deletions: 7 }}
      />,
    );
    // SSR splits the text/number into adjacent nodes with `<!-- -->`.
    expect(html).toContain('+<!-- -->42');
    expect(html).toContain('-<!-- -->7');
    expect(html).toContain(
      'inline-flex items-center gap-1 whitespace-nowrap text-2xs font-normal leading-4 tabular-nums',
    );
    expect(html).toContain('data-testid="worktree-row-trailing-diff"');
    expect(html).toContain('ml-auto inline-flex shrink-0');
    expect(html).not.toContain('data-testid="worktree-row-subtitle-separator"');
    expect(html).not.toContain('data-testid="diff-stats-badge" class="rounded');
    // Values under 1,000 are already short enough — no hover tooltip.
    expect(html).not.toContain('title="+42 -7"');
  });

  it('condenses large sidebar diff counts and keeps the exact values on hover', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/diff-stats"
        uiStatus="idle"
        diffStats={{ insertions: 1234, deletions: 999_999 }}
      />,
    );
    expect(html).toContain('+<!-- -->1k');
    expect(html).toContain('-<!-- -->999k');
    expect(html).not.toContain('1234');
    expect(html).toContain('title="+1,234 -999,999"');
  });

  it('condenses only the side that exceeds a thousand', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/diff-stats"
        uiStatus="idle"
        diffStats={{ insertions: 1_234_567, deletions: 8 }}
      />,
    );
    expect(html).toContain('+<!-- -->1M');
    expect(html).toContain('-<!-- -->8');
    expect(html).toContain('title="+1,234,567 -8"');
  });

  it('renders complete left-nav diff stats when requested', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/diff-stats"
        uiStatus="idle"
        diffStats={{ insertions: 1_234, deletions: 12_345 }}
        diffStatsStyle="complete"
      />,
    );
    expect(html).toContain('+<!-- -->1234');
    expect(html).toContain('-<!-- -->12345');
    expect(html).not.toContain('title="+1,234 -12,345"');
  });

  it('leaves the default DiffStatsBadge variant unabbreviated', () => {
    const html = renderToString(
      <DiffStatsBadge stats={{ insertions: 1234, deletions: 999_999 }} />,
    );
    expect(html).toContain('+<!-- -->1234');
    expect(html).toContain('-<!-- -->999999');
    expect(html).not.toContain('1k');
    expect(html).not.toContain('title=');
  });

  it('condenses the DiffStatsBadge when the condensed variant is requested', () => {
    const html = renderToString(
      <DiffStatsBadge
        stats={{ insertions: 1_234_567_890, deletions: 0 }}
        variant="condensed"
      />,
    );
    expect(html).toContain('+<!-- -->1B');
    expect(html).toContain('title="+1,234,567,890"');
    // Zero-valued sides stay hidden, exactly as in the default variant.
    expect(html).not.toContain('-<!-- -->0');
  });

  it('does not render the diff stats when both insertions and deletions are zero', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        diffStats={{ insertions: 0, deletions: 0 }}
      />,
    );
    expect(html).not.toContain('+<!-- -->0');
  });

  it('forwards the drag handle slot in place of the default status dot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        dragHandleSlot={<span data-testid="custom-drag">drag</span>}
      />,
    );
    expect(html).toContain('data-testid="custom-drag"');
  });

  it('does not mount an empty classic drag overlay for a null slot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        dragHandleSlot={null}
      />,
    );
    expect(html).not.toContain('data-testid="worktree-row-drag-overlay"');
  });

  it('does not mount an empty classic drag overlay for a false slot', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        dragHandleSlot={false}
      />,
    );
    expect(html).not.toContain('data-testid="worktree-row-drag-overlay"');
  });

  it('mounts pipeline + terminal popover slots when provided', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="running"
        terminalStatus="running"
        pipelinePopoverSlot={<span data-testid="pipe-pop">pipe</span>}
        terminalPopoverSlot={<span data-testid="term-pop">term</span>}
      />,
    );
    expect(html).toContain('data-testid="pipe-pop"');
    expect(html).toContain('data-testid="term-pop"');
  });

  it('exposes pipeline popovers with valid disclosure semantics', () => {
    const passive = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="running"
        pipelinePopoverListId="pipeline-list"
      />,
    );
    expect(passive).toContain('role="img"');
    expect(passive).not.toContain('role="button"');
    expect(passive).not.toContain('aria-expanded');
    expect(passive).not.toContain('aria-controls="pipeline-list"');
    expect(passive).not.toContain('aria-haspopup');
    expect(passive).not.toContain('tabindex="0"');

    const closed = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="running"
        pipelinePopoverListId="pipeline-list"
        onPipelineIconMouseEnter={jest.fn()}
        onPipelineIconKeyDown={jest.fn()}
      />,
    );
    expect(closed).toContain('role="button"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('aria-controls="pipeline-list"');
    expect(closed).not.toContain('aria-haspopup');

    const open = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        pipelineStatus="running"
        pipelinePopoverListId="pipeline-list"
        pipelinePopoverSlot={<span>Pipeline popover</span>}
        onPipelineIconMouseEnter={jest.fn()}
        onPipelineIconKeyDown={jest.fn()}
      />,
    );
    expect(open).toContain('role="button"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="pipeline-list"');
  });

  it('renders the action chip slot at the row tail', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        actionChipSlot={<span data-testid="chip">menu</span>}
      />,
    );
    expect(html).toContain('data-testid="chip"');
  });

  it('forwards workspace/worktree ids for automation', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        dataProjectId="project-123"
        dataWorktreeId="wt-123"
      />,
    );
    expect(html).toContain('data-project-id="project-123"');
    expect(html).toContain('data-worktree-id="wt-123"');
  });

  describe('status indicators — operational colors match desktop', () => {
    it('omits the empty right rail instead of rendering an idle dot', () => {
      const html = renderToString(
        <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
      );
      expect(html).not.toContain(
        'data-testid="worktree-idle-status-placeholder"',
      );
      expect(html).not.toContain('data-testid="worktree-row-status-rail"');
      expect(html).not.toContain('border-fg-secondary/60');
      expect(html).not.toContain('bg-fg-secondary/16');
    });

    it('renders working as the accent pipeline icon in the rail', () => {
      const html = renderToString(
        <WorktreeRow branchLabel="b" branchName="b" uiStatus="working" />,
      );
      expect(html).toContain('data-testid="worktree-row-working-pipeline"');
      // Accent = "running" (spinner/loaders); purple stays reserved for done.
      expect(html).toContain('fg-accent');
      expect(html).not.toContain('fg-purple');
      expect(html).not.toContain(
        'h-1.5 w-1.5 rounded-full bg-current fg-purple',
      );
      expect(html).not.toContain('border-fg-info');
    });

    it('renders planning as the orange approval shield in the rail', () => {
      const html = renderToString(
        <WorktreeRow branchLabel="b" branchName="b" uiStatus="planning" />,
      );
      expect(html).toContain('data-testid="worktree-row-planning-approval"');
      expect(html).toContain('fg-warning');
      expect(html).not.toContain(
        'h-1.5 w-1.5 rounded-full bg-current fg-warning',
      );
      expect(html).not.toContain('border-fg-info');
    });

    it('renders the unread dot with the shared sidebar blue', () => {
      const html = renderToString(
        <WorktreeRow branchLabel="b" branchName="b" uiStatus="unread" />,
      );
      expect(html).toContain('h-1.5 w-1.5 rounded-full bg-current fg-blue');
      expect(html).not.toContain('border-fg-info');
    });
  });

  it('uses subtle hover and muted selected row surfaces', () => {
    const idleHtml = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
    );
    const selectedHtml = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" selected />,
    );
    expect(idleHtml).toContain('hover:bg-subtle');
    expect(selectedHtml).toContain('bg-muted fg-primary');
    expect(selectedHtml).not.toContain('hover:bg-subtle');
    expect(selectedHtml).not.toContain('border-l-2 border-line-accent');
  });

  it('keeps the default cursor on sortable sidebar rows', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Sortable task"
        branchName="sortable-task"
        uiStatus="idle"
        textScale="sidebar"
        onDragPointerDown={jest.fn()}
      />,
    );

    expect(html).toContain('cursor-default');
    expect(html).toContain('touch-none select-none');
    expect(html).not.toContain('cursor-grab');
    expect(html).not.toContain('active:cursor-grabbing');
  });

  it('keeps click-only rows interactive without adding a drag cursor', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Clickable task"
        branchName="clickable-task"
        uiStatus="idle"
        textScale="sidebar"
        onClick={jest.fn()}
      />,
    );

    expect(html).toContain('cursor-pointer');
    expect(html).not.toContain('cursor-grab');
    expect(html).not.toContain('cursor-grabbing');
  });

  it('renders the depth counter inline with the identity and preserves hover actions', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Nested worktree"
        branchName="feat-c"
        worktreeId="dev-ibex"
        uiStatus="idle"
        textScale="sidebar"
        depthBadge={{
          depth: 2,
          topMost: { branchName: 'feat-a', animalName: 'otter' },
          directParent: { branchName: 'feat-b', animalName: 'lynx' },
        }}
        actionChipSlot={
          <WorktreeRowActionChip>
            <button type="button">Actions</button>
          </WorktreeRowActionChip>
        }
      />,
    );
    const subtitlePosition = html.indexOf('worktree-row-subtitle');
    const depthPosition = html.indexOf('worktree-row-depth-badge');
    const identityPosition = html.indexOf('dev-ibex', depthPosition);

    expect(subtitlePosition).toBeGreaterThanOrEqual(0);
    expect(depthPosition).toBeGreaterThan(subtitlePosition);
    expect(identityPosition).toBeGreaterThan(depthPosition);
    expect(html.slice(depthPosition, identityPosition)).toContain('·');
    expect(html).toContain('data-depth="2"');
    expect(html).toContain('under top-most parent feat-a');
    expect(html).toContain(
      'class="focus-ring -mx-2.25 inline-flex h-4 min-w-6 items-center justify-center rounded-sm px-2.25 outline-none"',
    );
    expect(html).not.toContain('rounded-full bg-accent-subtle');
    expect(html).toContain('data-testid="worktree-row-action-chip"');
  });

  it('renders no depth badge when depthBadge is undefined', () => {
    const html = renderToString(
      <WorktreeRow branchLabel="a" branchName="a" uiStatus="idle" />,
    );
    expect(html).not.toContain('worktree-row-depth-badge');
  });

  it('shows the direct parent line in the tooltip content only when it differs', () => {
    // Branch names sit in their own span, so compare rendered text.
    const text = (html: string): string => html.replace(/<[^>]+>/g, '');
    const withDiff = renderToString(
      <DepthBadgeTooltipContent
        badge={{
          depth: 2,
          topMost: { branchName: 'feat-a', animalName: 'otter' },
          directParent: { branchName: 'feat-b', animalName: 'lynx' },
        }}
      />,
    );
    expect(text(withDiff)).toContain('Top-most parent: feat-a (otter)');
    expect(text(withDiff)).toContain('Direct parent: feat-b (lynx)');

    const depthOne = renderToString(
      <DepthBadgeTooltipContent
        badge={{
          depth: 1,
          topMost: { branchName: 'feat-a', animalName: 'otter' },
        }}
      />,
    );
    expect(text(depthOne)).toContain('Top-most parent: feat-a (otter)');
    expect(depthOne).not.toContain('Direct parent:');
  });

  describe('pinned-to-top badge', () => {
    it('renders a quiet pin with its accessible label when pinned', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/pinned"
          branchName="feature/pinned"
          uiStatus="idle"
          textScale="sidebar"
          pinnedToTop
        />,
      );

      expect(html).toContain('data-testid="worktree-row-pinned-badge"');
      expect(html).toContain('aria-label="Pinned"');
      // It shares pixels with the revealed hover actions, so it fades and
      // goes inert on row hover, like the shared badge.
      expect(html).toContain('pointer-fine:group-hover/sidebar-item:opacity-0');
      expect(html).toContain('pointer-events-none');
    });

    it('is absent unless the host opts in', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/pinned"
          branchName="feature/pinned"
          uiStatus="idle"
          textScale="sidebar"
        />,
      );

      expect(html).not.toContain('worktree-row-pinned-badge');
    });

    it('suffixes its automation id for mounted row copies', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/pinned"
          branchName="feature/pinned"
          uiStatus="idle"
          textScale="sidebar"
          pinnedToTop
          testIdSuffix="-pin-top"
        />,
      );

      expect(html).toContain('worktree-row-pinned-badge-pin-top');
      expect(html).not.toContain('data-testid="worktree-row-pinned-badge"');
    });

    it('sits left of the shared badge and the live status cluster', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/pinned"
          branchName="feature/pinned"
          uiStatus="working"
          isStreaming
          textScale="sidebar"
          sharedWithTeammates
          pinnedToTop
        />,
      );

      const title = html.indexOf('data-testid="worktree-row-title"');
      const pin = html.indexOf('data-testid="worktree-row-pinned-badge"');
      const shared = html.indexOf('data-testid="worktree-row-shared-badge"');
      const status = html.indexOf('data-testid="worktree-row-trailing-slot"');

      expect(title).toBeGreaterThan(-1);
      expect(pin).toBeGreaterThan(title);
      expect(shared).toBeGreaterThan(pin);
      expect(status).toBeGreaterThan(shared);
    });

    it('never claims the leading slot', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/pinned"
          branchName="feature/pinned"
          uiStatus="idle"
          textScale="sidebar"
          pipelineStatus="paused"
          pinnedToTop
        />,
      );

      expect(
        html.indexOf('data-testid="worktree-row-paused-pipeline"'),
      ).toBeLessThan(html.indexOf('data-testid="worktree-row-title"'));
      expect(
        html.indexOf('data-testid="worktree-row-pinned-badge"'),
      ).toBeGreaterThan(html.indexOf('data-testid="worktree-row-title"'));
    });
  });

  describe('shared-with-teammates badge', () => {
    it('renders the share glyph with its accessible label when shared', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          sharedWithTeammates
        />,
      );

      expect(html).toContain('data-testid="worktree-row-shared-badge"');
      // Assert the aria-label specifically. `textScale="sidebar"` takes the
      // fading path, where no tooltip is mounted, so a bare substring check
      // for the label would pass on an incidental match and mask a real
      // regression that dropped the accessible name.
      expect(html).toContain('aria-label="Shared with teammates"');
      expect(html).toContain('fg-quaternary');
    });

    it('renders on the non-classic layout too', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          sharedWithTeammates
        />,
      );

      expect(html).toContain('data-testid="worktree-row-shared-badge"');
    });

    it('suffixes its automation id for mounted row copies', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          sharedWithTeammates
          testIdSuffix="-pin-top"
        />,
      );

      expect(html).toContain('worktree-row-shared-badge-pin-top');
      expect(html).not.toContain('data-testid="worktree-row-shared-badge"');
    });

    it('is absent unless the host opts in', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
        />,
      );

      expect(html).not.toContain('worktree-row-shared-badge');
    });

    it('never claims the leading slot — the live subject still wins it', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          pipelineStatus="paused"
          sharedWithTeammates
        />,
      );

      const leadingSlot = html.indexOf(
        'data-testid="worktree-row-leading-slot"',
      );
      const subtitle = html.indexOf('data-testid="worktree-row-subtitle"');
      const pipelineGlyph = html.indexOf(
        'data-testid="worktree-row-paused-pipeline"',
      );
      const sharedBadge = html.indexOf(
        'data-testid="worktree-row-shared-badge"',
      );

      expect(leadingSlot).toBeGreaterThan(-1);
      expect(subtitle).toBeGreaterThan(leadingSlot);
      // The paused-pipeline glyph still owns the leading slot...
      expect(pipelineGlyph).toBeGreaterThan(leadingSlot);
      expect(pipelineGlyph).toBeLessThan(subtitle);
      // ...and the shared badge lives on the title line, past the leading
      // slot but before the subtitle — the same slot the Cowork row uses.
      expect(sharedBadge).toBeGreaterThan(leadingSlot);
      expect(sharedBadge).toBeLessThan(subtitle);
    });

    it("sits at the title line's trailing edge, left of the status cluster", () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="working"
          textScale="sidebar"
          sharedWithTeammates
        />,
      );

      const title = html.indexOf('data-testid="worktree-row-title"');
      const sharedBadge = html.indexOf(
        'data-testid="worktree-row-shared-badge"',
      );
      const trailingSlot = html.indexOf(
        'data-testid="worktree-row-trailing-slot"',
      );

      expect(title).toBeGreaterThan(-1);
      expect(trailingSlot).toBeGreaterThan(-1);
      expect(sharedBadge).toBeGreaterThan(title);
      expect(sharedBadge).toBeLessThan(trailingSlot);
    });

    it('fades out under a fine pointer while the row reveals its actions', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          sharedWithTeammates
        />,
      );

      // Opacity, not unmount: the footprint is preserved so nothing on the
      // row jumps when the pointer arrives. Inert so the faded glyph cannot
      // swallow a click aimed at the ••• it now sits under.
      const badgeTag = html.slice(
        html.lastIndexOf('<span', html.indexOf('worktree-row-shared-badge')),
        html.indexOf('worktree-row-shared-badge'),
      );
      expect(badgeTag).toContain(
        'pointer-fine:group-hover/sidebar-item:opacity-0',
      );
      expect(badgeTag).toContain(
        'pointer-fine:group-focus-within/sidebar-item:opacity-0',
      );
      expect(html).toContain('pointer-events-none');
    });

    it('does not suppress or reorder the other subtitle badges', () => {
      const html = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          terminalStatus="running"
          scriptStatus="running"
          hookStatus="running"
          lastKnownPrStatus={{ state: 'open', label: 'PR #4242' }}
          sharedWithTeammates
        />,
      );

      expect(html).toContain('data-testid="worktree-row-terminal-badge"');
      expect(html).toContain('data-testid="worktree-row-script-badge"');
      expect(html).toContain('data-testid="worktree-row-hook-badge"');
      expect(html).toContain('data-testid="worktree-row-pr-badge"');
      expect(html).toContain('data-testid="worktree-row-shared-badge"');

      const withoutShared = renderToString(
        <WorktreeRow
          branchLabel="feature/shared"
          branchName="feature/shared"
          uiStatus="idle"
          textScale="sidebar"
          terminalStatus="running"
          scriptStatus="running"
          hookStatus="running"
          lastKnownPrStatus={{ state: 'open', label: 'PR #4242' }}
        />,
      );

      // Badge order is unchanged by the new badge: the shared glyph is
      // appended, never interleaved, and no existing badge is suppressed.
      const badgeOrder = (markup: string): string[] => {
        const testIds: string[] = [];
        const pattern = /data-testid="(worktree-row-[a-z-]+)"/g;
        let match = pattern.exec(markup);
        while (match !== null) {
          const testId: string | undefined = match[1];
          if (testId !== undefined && testId !== 'worktree-row-shared-badge') {
            testIds.push(testId);
          }
          match = pattern.exec(markup);
        }
        return testIds;
      };
      expect(withoutShared).not.toContain('worktree-row-shared-badge');
      expect(badgeOrder(html)).toEqual(badgeOrder(withoutShared));
      // The shared glyph moved to the title line, so it now precedes every
      // subtitle badge rather than trailing them. What matters is unchanged:
      // it neither suppresses nor reorders them.
      const sharedIndex = html.indexOf(
        'data-testid="worktree-row-shared-badge"',
      );
      for (const testId of [
        'worktree-row-terminal-badge',
        'worktree-row-hook-badge',
        'worktree-row-pr-badge',
      ]) {
        expect(html.indexOf(`data-testid="${testId}"`)).toBeGreaterThan(
          sharedIndex,
        );
      }
    });
  });
});

describe('WorktreeRowActionChip', () => {
  it('keeps action buttons clickable when the row owns a drag cursor', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="drag row"
        branchName="drag-row"
        uiStatus="idle"
        dragCursor
        actionChipSlot={
          <WorktreeRowActionChip>
            <button type="button">kebab</button>
          </WorktreeRowActionChip>
        }
      />,
    );

    expect(html).toContain('pointer-fine:hover:cursor-grab');
    // Action buttons keep the plain arrow cursor — a hand cursor here
    // flickers against the row's grab cursor on macOS.
    expect(html).toContain('[&amp;_button]:cursor-default');
    expect(html).not.toContain('[&amp;_button]:cursor-pointer');
  });

  // The grab cursor is a hover affordance; a row the pointer is not over (or
  // is merely near, as the desktop rail measures it) keeps the plain arrow
  // rather than the browser's `auto`, which turns to a text caret over copy.
  it('keeps the arrow cursor at rest on a drag-enabled row', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="drag row"
        branchName="drag-row"
        uiStatus="idle"
        textScale="sidebar"
        dragCursor
      />,
    );

    expect(html).toMatch(/[" ]cursor-default pointer-fine:hover:cursor-grab/);
  });

  it('uses the grabbing cursor while a drag-enabled row is dragging', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="drag row"
        branchName="drag-row"
        uiStatus="idle"
        dragCursor
        isDragging
      />,
    );

    expect(html).toContain('pointer-fine:cursor-grabbing');
    expect(html).not.toContain('pointer-fine:hover:cursor-grab');
  });

  it('list mode floats bare actions over the row tail', () => {
    const html = renderToString(
      <WorktreeRowActionChip>
        <button type="button">kebab</button>
      </WorktreeRowActionChip>,
    );
    // Absolute overlay: consumes no layout width, so badges stay flush right.
    // Fine pointers align the compact control with the label line, while coarse
    // pointers center the 44px hitbox in the 44px row so adjacent controls
    // cannot overlap.
    expect(html).toContain('absolute right-1 top-[calc(50%-0.5625rem)]');
    expect(html).toContain('pointer-coarse:top-1/2');
    expect(html).not.toContain('shadow');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('z-40');
  });

  it('centers the leading indicator on the label line', () => {
    // Sidebar rows stack the label over a fixed subtitle block
    // (mt-0.5 + h-4 = 1.125rem). The leading indicator centers on the label
    // line, not the two-line block, via an upward shift of half that block.
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/foo"
        branchName="feature/foo"
        uiStatus="idle"
        textScale="sidebar"
      />,
    );
    const slotEnd = html.indexOf('data-testid="worktree-row-leading-slot"');
    expect(slotEnd).toBeGreaterThan(-1);
    const leadingSlot = html.slice(Math.max(0, slotEnd - 400), slotEnd);
    expect(leadingSlot).toContain('-translate-y-2.25');
  });

  it('menuOpen hides the actions without adding a surface', () => {
    const html = renderToString(
      <WorktreeRowActionChip menuOpen>
        <button type="button">kebab</button>
      </WorktreeRowActionChip>,
    );
    // The open menu already identifies its row, and its trigger holds focus —
    // so `group-focus-within` would keep the whole cluster lit for as long as
    // the menu is up. Hiding the chip beats the children's own reveal classes.
    expect(html).toContain('opacity-0');
    // The trigger stays in the DOM as the menu's anchor rather than unmounting.
    expect(html).toContain('kebab');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('shadow');
  });

  it('leaves the actions revealable when no menu is open', () => {
    const html = renderToString(
      <WorktreeRowActionChip>
        <button type="button">kebab</button>
      </WorktreeRowActionChip>,
    );
    expect(html).not.toContain('opacity-0');
  });

  it('alwaysVisible marks persistent done-row actions without a surface', () => {
    const html = renderToString(
      <WorktreeRowActionChip alwaysVisible>
        <button type="button">kebab</button>
      </WorktreeRowActionChip>,
    );
    expect(html).toContain('data-always-visible="true"');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('shadow');
  });

  it('kanban mode renders the inline full-width strip', () => {
    const html = renderToString(
      <WorktreeRowActionChip displayMode="kanban">
        <button type="button">kebab</button>
      </WorktreeRowActionChip>,
    );
    expect(html).toContain('flex w-full items-center gap-0.5');
    expect(html).not.toContain('absolute right-1');
  });
});

describe('worktreeRowActionButtonClass', () => {
  it('hover-revealed buttons stay visible on coarse pointers (touch)', () => {
    const revealed = worktreeRowActionButtonClass(true);
    expect(revealed).toContain('opacity-0');
    expect(revealed).toContain('group-hover:opacity-100');
    expect(revealed).toContain('pointer-coarse:opacity-100');
    expect(revealed).toContain('pointer-coarse:min-h-11');
    expect(revealed).toContain('pointer-coarse:min-w-11');
    expect(revealed).toContain('hover:fg-primary');
    expect(revealed).not.toContain('hover:bg-');
  });

  it('non-revealed buttons are always visible', () => {
    const persistent = worktreeRowActionButtonClass(false);
    expect(persistent).not.toContain('opacity-0');
    expect(persistent).toContain('pointer-coarse:min-h-11');
    expect(persistent).toContain('pointer-coarse:min-w-11');
    expect(persistent).toContain('hover:fg-primary');
    expect(persistent).not.toContain('hover:bg-');
  });
});

describe('WorktreeRow coarse-pointer layout', () => {
  it('uses the full resting label width until hover actions are revealed', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Health warning + diff"
        branchName="health-warning-diff"
        uiStatus="idle"
        textScale="sidebar"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
        actionChipButtonCount={2}
      />,
    );

    expect(html).toContain('pointer-fine:group-hover:pr-13.5');
    expect(html).toContain('pointer-fine:group-focus-within:pr-13.5');
    expect(html).not.toContain('self-center pr-7');
    expect(html).not.toContain('self-center pr-13.5');
  });

  it('reserves the right status rail so long subtitles truncate before indicators', () => {
    // Default text scale: the status-rail treatment only remains on
    // non-sidebar rows now that sidebar rows are always classic.
    const html = renderToString(
      <WorktreeRow
        branchLabel="Split PR review"
        branchName="split-pr-review"
        worktreeId="feature/split-pr-review"
        uiStatus="idle"
        splitStatus="review"
        splitStatusMessage="Waiting for your plan approval"
      />,
    );

    expect(html).toContain(' pr-7');
    expect(html).toContain('data-testid="worktree-row-status-rail"');
    expect(html).toContain('block min-w-0 truncate whitespace-nowrap');
  });

  it('reserves the chip footprint on touch when an action chip is present', () => {
    const withChip = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
      />,
    );
    expect(withChip).toContain('pointer-coarse:pr-12');

    const withoutChip = renderToString(
      <WorktreeRow branchLabel="b" branchName="b" uiStatus="idle" />,
    );
    expect(withoutChip).not.toContain('pointer-coarse:pr-12');
  });

  it('reveals the two-button chip footprint on done-row hover and keyboard focus', () => {
    const done = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
      />,
    );
    expect(done).toContain('pointer-fine:group-hover:pr-13.5');
    expect(done).toContain('pointer-fine:group-focus-within:pr-13.5');
    expect(done).toContain('pointer-coarse:pr-12');
  });

  it('shows the compact done status rail until hover actions replace it', () => {
    const done = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
      />,
    );

    expect(done).toContain('data-testid="worktree-row-status-rail"');
    expect(done).toContain('group-hover:opacity-0');
  });

  it('preserves resting space and suppresses the status rail for persistent actions', () => {
    const done = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="done"
        runtimeState="done"
        actionChipSlot={
          <WorktreeRowActionChip alwaysVisible>x</WorktreeRowActionChip>
        }
        actionChipButtonCount={2}
        actionChipAlwaysVisible
      />,
    );

    expect(done).toContain('pr-13.5 pointer-coarse:pr-12');
    expect(done).not.toContain('pointer-fine:group-hover:pr-13.5');
    expect(done).not.toContain('data-testid="worktree-row-status-rail"');
  });

  it('replaces interactive compact status controls with row actions on hover', () => {
    const row = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        awaitingApproval
        onApprovalIconMouseEnter={jest.fn()}
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
        actionChipButtonCount={2}
      />,
    );

    expect(row).toContain('pr-7');
    expect(row).toContain('pointer-fine:group-hover:pr-13.5');
    expect(row).toContain(
      'absolute right-1 top-[calc(50%-0.5625rem)] inline-flex h-6 w-6',
    );
    expect(row).toContain(
      'group-hover:pointer-events-none group-hover:opacity-0',
    );
  });

  it('reveals only the measured three-button footprint', () => {
    const done = renderToString(
      <WorktreeRow
        branchLabel="Hidden completed task"
        branchName="hidden-completed-task"
        uiStatus="done"
        runtimeState="done"
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
        actionChipButtonCount={3}
      />,
    );
    expect(done).toContain('pointer-fine:group-hover:pr-20');
    expect(done).toContain('pointer-fine:group-focus-within:pr-20');
    expect(done).not.toContain('pr-[5.75rem]');
  });

  it('keeps diff metadata visible on hover with its right padding', () => {
    // The +x/−x counters live on the subtitle line, which the hover action
    // chips never cover — hiding them on hover was needless flicker. They
    // stay visible and carry a 4px right inset.
    const html = renderToString(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        worktreeId="feature/diff-hover"
        uiStatus="idle"
        diffStats={{ insertions: 3, deletions: 1 }}
        actionChipSlot={<WorktreeRowActionChip>x</WorktreeRowActionChip>}
      />,
    );
    expect(html).toContain('data-testid="worktree-row-trailing-diff"');
    expect(html).toContain('ml-auto inline-flex shrink-0 pr-0.75');
    expect(html).not.toContain('pointer-fine:group-hover:opacity-0');
    expect(html).not.toContain('pointer-fine:group-focus-within:opacity-0');
  });
});

it.each(['classic', 'focused'] as const)(
  'masks the identity text in the %s sidebar layout',
  (statusModel) => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="Private task"
        branchName="feature/private"
        worktreeId="private-otter"
        uiStatus="idle"
        textScale="sidebar"
        statusModel={statusModel}
      />,
    );
    expect(html).toContain('<span class="ph-mask">private-otter</span>');
  },
);
