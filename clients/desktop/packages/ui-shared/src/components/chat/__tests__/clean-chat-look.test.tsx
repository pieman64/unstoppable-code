/**
 * The clean chat look (desktop "Clean chat" Labs experiment). Every shared
 * transcript part must render exactly as before under the classic look, and
 * read as one plain step style under the clean look.
 */
import type { JSX, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatLookProvider, type ChatLook } from '../../chat-look';
import { ChatToolStepGroup } from '../../ChatToolStepGroup';
import { ForkChatButton } from '../../ForkChatButton';
import {
  TurnFeedbackAsMenuItemsContext,
  TurnFeedbackControl,
} from '../../TurnFeedbackControl';
import { TurnTimer } from '../../TurnTimer';
import { UserBubble } from '../../UserBubble';
import { AgentBlockCard } from '../AgentBlockCard';
import { ChatAppNote } from '../ChatAppNote';
import { CompactionInfoBlock } from '../CompactionInfoBlock';
import { CollapsedTurnSummary } from '../CollapsedTurnSummary';
import { CollapsibleBlock, thinkingHeadline } from '../CollapsibleBlock';
import { STEP_ROW_BODY_CLASS, StepRow } from '../StepRow';
import { ToolCallCard } from '../ToolCallCard';
import { GitBranchLineIcon } from '../../../icons/AppIcons';
import { TurnMoreMenu } from '../TurnMoreMenu';
import { TurnWorkHeader, formatWorkDuration } from '../TurnWorkHeader';
import { describeStepCounts, describeStepKinds } from '../step-words';
import {
  getToolDisplayInfo,
  hasTensedStepLabel,
  readableToolInput,
} from '../tool-display';

function render(look: ChatLook, node: ReactNode): string {
  return renderToStaticMarkup(
    <ChatLookProvider value={look}>{node}</ChatLookProvider>,
  );
}

function Label({ name, input }: { name: string; input: string }): JSX.Element {
  return <>{getToolDisplayInfo(name, input).label}</>;
}

const BASH_INPUT = JSON.stringify({
  command: 'npx jest packages/ui-shared',
  description: 'Run the icon tests',
});

describe('clean chat look', () => {
  it('leaves every part classic without a provider', () => {
    const html = renderToStaticMarkup(
      <ToolCallCard toolName="Bash" input={BASH_INPUT} status="error" />,
    );
    expect(html).not.toContain('tool-call-failed');
    expect(html).toContain('fg-destructive');
  });

  describe('tool rows', () => {
    function bashCard(status: 'pending' | 'success' | 'error'): JSX.Element {
      return (
        <ToolCallCard
          toolName="Bash"
          input={BASH_INPUT}
          label={<Label name="Bash" input={BASH_INPUT} />}
          status={status}
        />
      );
    }

    it('says how a command went in its verb, without color', () => {
      expect(render('clean', bashCard('success'))).toContain(
        'Ran npx jest packages/ui-shared',
      );
      expect(render('clean', bashCard('pending'))).toContain(
        'Running npx jest packages/ui-shared',
      );
      const failed = render('clean', bashCard('error'));
      expect(failed).toContain('Couldn’t run npx jest packages/ui-shared');
      expect(failed).not.toContain('fg-destructive');
      expect(failed).not.toContain('tool-call-failed');
      expect(render('classic', bashCard('success'))).toContain(
        'Run the icon tests',
      );
    });

    it('names a failure in words when the label has no verb for it', () => {
      const card = (
        <ToolCallCard toolName="WebFetch" input="{}" status="error" />
      );
      expect(render('classic', card)).not.toContain('tool-call-failed');
      const clean = render('clean', card);
      expect(clean).toContain('data-testid="tool-call-failed"');
      expect(clean).toContain('>failed<');
      expect(clean).not.toContain('fg-destructive');
    });

    it('knows which tools say their own outcome', () => {
      expect(hasTensedStepLabel('Bash', BASH_INPUT)).toBe(true);
      expect(
        hasTensedStepLabel('Read', JSON.stringify({ file_path: '/repo/a.ts' })),
      ).toBe(true);
      // A bare "Read" has no verb to say it failed.
      expect(hasTensedStepLabel('Read', '{}')).toBe(false);
      expect(hasTensedStepLabel('WebFetch')).toBe(false);
      expect(hasTensedStepLabel('file_change', 'update: src/a.ts')).toBe(true);
      // "File changes (2 files)" has no verb to say it failed.
      expect(
        hasTensedStepLabel('file_change', 'update: src/a.ts\nadd: src/b.ts'),
      ).toBe(false);
    });

    it('judges a host-supplied label, as large-output steps pass no input', () => {
      const failed = (label: ReactNode): string =>
        render(
          'clean',
          <ToolCallCard
            toolName="Bash"
            label={label}
            result={{ kind: 'error', content: 'exit 1' }}
          />,
        );
      // "Couldn't run …" already says it: no second "failed".
      const tensed = failed(getToolDisplayInfo('Bash', BASH_INPUT).label);
      expect(tensed).toContain('Couldn’t run npx jest packages/ui-shared');
      expect(tensed).not.toContain('data-testid="tool-call-failed"');
      // A plain label has no verb, so the row still names the failure.
      expect(failed('Bash')).toContain('data-testid="tool-call-failed"');
    });

    it('marks a failed Read without a path in the clean look', () => {
      const card = (
        <ToolCallCard
          toolName="Read"
          input="{}"
          result={{ kind: 'error', content: 'missing file_path' }}
        />
      );
      expect(render('clean', card)).toContain('data-testid="tool-call-failed"');
    });

    it('marks a failed multi-file change in the clean look', () => {
      const card = (
        <ToolCallCard
          toolName="file_change"
          input={'update: src/a.ts\nadd: src/b.ts'}
          result={{ kind: 'error', content: 'declined' }}
        />
      );
      expect(render('clean', card)).toContain('data-testid="tool-call-failed"');
    });

    it('shows the command instead of raw JSON when opened', () => {
      const card = (
        <ToolCallCard
          toolName="Bash"
          input={BASH_INPUT}
          defaultCollapsed={false}
          status="success"
        />
      );
      expect(render('classic', card)).toContain('&quot;command&quot;');
      const clean = render('clean', card);
      expect(clean).not.toContain('&quot;command&quot;');
      expect(clean).toContain('npx jest packages/ui-shared');
    });

    it('shimmers a running step instead of showing a spinner', () => {
      const card = (
        <ToolCallCard
          toolName="Bash"
          input={BASH_INPUT}
          status="pending"
          pendingSpinner={<span data-testid="spinner" />}
        />
      );
      expect(render('classic', card)).toContain('data-testid="spinner"');
      const clean = render('clean', card);
      expect(clean).not.toContain('data-testid="spinner"');
      expect(clean).toContain('canopy-text-shimmer');
    });

    it('drops code chips and code font from details', () => {
      const read = (
        <Label name="Read" input={JSON.stringify({ file_path: 'a/b.tsx' })} />
      );
      expect(render('classic', read)).toContain('<code');
      expect(render('clean', read)).not.toContain('<code');
      expect(render('clean', read)).toContain('Read <span>b.tsx</span>');
      const bash = <Label name="Bash" input={BASH_INPUT} />;
      expect(render('classic', bash)).toContain('font-mono');
      expect(render('clean', bash)).not.toContain('font-mono');
    });

    it('says what a search did instead of the raw Grep tool name', () => {
      const grep = (
        <Label name="Grep" input={JSON.stringify({ pattern: 'RobotIcon' })} />
      );
      expect(render('classic', grep)).toContain('Grep');
      expect(render('clean', grep)).toContain('Searched for');
      expect(render('clean', grep)).not.toContain('Grep');
    });
  });

  describe('readableToolInput', () => {
    it('reads a shell call as its command', () => {
      expect(readableToolInput('Bash', BASH_INPUT)).toBe(
        'npx jest packages/ui-shared',
      );
    });

    it('lists other JSON fields one per line', () => {
      expect(
        readableToolInput(
          'Read',
          JSON.stringify({ file_path: 'a.ts', limit: 20 }),
        ),
      ).toBe('file_path: a.ts\nlimit: 20');
    });

    it('keeps input that is not a JSON object', () => {
      expect(readableToolInput('Read', 'plain text')).toBe('plain text');
      expect(readableToolInput('Read', '[1,2]')).toBe('[1,2]');
    });
  });

  describe('step groups', () => {
    const group = (
      <ChatToolStepGroup
        summary="Ran commands"
        icon={<span data-testid="kind-icon" />}
      >
        <span data-testid="group-step" />
      </ChatToolStepGroup>
    );

    it('leads with the kind icon only under the clean look', () => {
      expect(render('classic', group)).not.toContain('kind-icon');
      expect(render('clean', group)).toContain('kind-icon');
    });

    it('stays open while a step runs, only under the clean look', () => {
      const running = (
        <ChatToolStepGroup summary="Ran commands" runningLabel="Running ls">
          <span data-testid="group-step" />
        </ChatToolStepGroup>
      );
      expect(render('classic', running)).not.toContain('group-step');
      const clean = render('clean', running);
      expect(clean).toContain('group-step');
      // The running step shimmers in the list, so the row doesn't repeat it.
      expect(clean).not.toContain('chat-tool-step-running');
      expect(render('clean', group)).not.toContain('group-step');
    });
  });

  describe('finished turn summary', () => {
    const summary = (
      <CollapsedTurnSummary
        summary={{ messages: 2, thinking: 1, bash: 2, read: 1, edit: 2 }}
        isExpanded={false}
        elapsedMs={204_000}
      />
    );

    it('keeps the step count and chips under the classic look', () => {
      const html = render('classic', summary);
      expect(html).toContain('8 steps');
      expect(html).toContain('data-tool-chip="bash"');
    });

    it('reads "Worked for" with the steps in words on hover', () => {
      const html = render('clean', summary);
      expect(html).toContain('Worked for 3m 24s');
      expect(html).toContain(
        'title="Thought, ran 2 commands, read 1 file, edited 2 files"',
      );
      expect(html).not.toContain('data-tool-chip');
    });

    it.each([
      ['failed', 'Failed after 3m 24s'],
      ['cancelled', 'Stopped after 3m 24s'],
    ] as const)('says a %s turn ended that way', (completionStatus, text) => {
      const html = render(
        'clean',
        <CollapsedTurnSummary
          summary={{ bash: 1 }}
          isExpanded={false}
          elapsedMs={204_000}
          completionStatus={completionStatus}
        />,
      );
      expect(html).toContain(text);
      expect(html).not.toContain('Worked for');
    });
  });

  describe('turn header', () => {
    const now = Date.now();

    it('counts the time a running turn has worked', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader startedAt={now - 28_000} live />,
      );
      expect(html).toContain('Working for 28s');
      expect(html).toContain('data-turn-header="live"');
    });

    it('waits for the person while the turn is paused', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader
          startedAt={now - 60_000}
          pausedAt={now - 30_000}
          live
        />,
      );
      expect(html).toContain('Waiting for you');
    });

    it('says how a finished turn ended, with a chevron when it folds', () => {
      const done = renderToStaticMarkup(
        <TurnWorkHeader elapsedMs={204_000} expandable />,
      );
      expect(done).toContain('Worked for 3m 24s');
      expect(done).toContain('aria-expanded="false"');
      expect(
        renderToStaticMarkup(
          <TurnWorkHeader elapsedMs={31_000} completionStatus="failed" />,
        ),
      ).toContain('Failed after 31s');
      expect(
        renderToStaticMarkup(
          <TurnWorkHeader elapsedMs={31_000} completionStatus="cancelled" />,
        ),
      ).toContain('Stopped after 31s');
    });

    it('reads as a plain step row, without a stopwatch', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader elapsedMs={204_000} expandable />,
      );
      expect(html).toContain('data-step-row');
      expect(html).toContain('text-s fg-secondary');
      expect(html).not.toContain('data-glyph="timer"');
    });

    it('keeps 8px between a step icon and its words', () => {
      const html = renderToStaticMarkup(
        <StepRow icon={<span />} label="Read AppIcons.tsx" />,
      );
      expect(html).toContain('items-center gap-2 py-1');
      expect(STEP_ROW_BODY_CLASS).toContain('ml-5.5');
      const note = renderToStaticMarkup(<ChatAppNote text="Connection lost" />);
      expect(note).toContain('items-start gap-2');
    });

    it('formats durations in words', () => {
      expect(formatWorkDuration(5)).toBe('5s');
      expect(formatWorkDuration(180)).toBe('3m');
      expect(formatWorkDuration(3_900)).toBe('1h 5m');
    });
  });

  describe('describeStepKinds', () => {
    it('says what was done without counting it', () => {
      expect(
        describeStepKinds([
          ['thinking', 2],
          ['command', 3],
          ['read', 1],
          ['search', 2],
        ]),
      ).toBe('Ran commands, read a file, searched the code');
    });

    it('keeps thinking when the run did nothing else', () => {
      expect(describeStepKinds([['thinking', 2]])).toBe('Thought');
    });
  });

  describe('describeStepCounts', () => {
    it('merges kinds in order and capitalizes the sentence', () => {
      expect(
        describeStepCounts([
          ['search', 3],
          ['read', 1],
          ['search', 1],
          ['other', 0],
        ]),
      ).toBe('Searched 4 times, read 1 file');
    });
  });

  describe('helper agents', () => {
    const agent = (
      <AgentBlockCard
        subagentType="Explore"
        description="Find icon registrations"
        dataTestId="agent-block"
      />
    );

    it('drops the coloured bar and accent ink under the clean look', () => {
      expect(render('classic', agent)).toContain('border-l-2');
      expect(render('classic', agent)).toContain('fg-accent/80');
      const clean = render('clean', agent);
      expect(clean).not.toContain('border-l-2');
      expect(clean).not.toContain('fg-accent/80');
    });

    it('names a failed helper in words under the clean look', () => {
      const failed = (
        <AgentBlockCard subagentType="Explore" isError dataTestId="a" />
      );
      expect(render('classic', failed)).toContain('>error<');
      expect(render('clean', failed)).toContain('>failed<');
      expect(render('clean', failed)).not.toContain('fg-destructive');
    });
  });

  describe('thinking', () => {
    it('shimmers while running and reads its done label after', () => {
      const running = (
        <CollapsibleBlock
          label="Thinking"
          doneLabel="Thought"
          running
          content="x"
        />
      );
      const done = (
        <CollapsibleBlock label="Thinking" doneLabel="Thought" content="x" />
      );
      expect(render('clean', running)).toContain('canopy-text-shimmer');
      expect(render('clean', running)).toContain('Thinking');
      expect(render('clean', done)).toContain('Thought');
      expect(render('clean', done)).not.toContain('canopy-text-shimmer');
      expect(render('classic', done)).toContain('Thinking');
    });

    it('shows the latest headline of the thoughts while running', () => {
      const content =
        '**Listing worktrees**\n\nSome text.\n\n**Checking worktree statuses**\n\nMore.';
      expect(thinkingHeadline(content)).toBe('Checking worktree statuses');
      expect(thinkingHeadline('No headline here')).toBeUndefined();
      const running = (
        <CollapsibleBlock
          label="Thinking"
          doneLabel="Thought"
          running
          content={content}
        />
      );
      expect(render('clean', running)).toContain('Checking worktree statuses');
    });

    it('hides the cut-off preview under the clean look', () => {
      const block = (
        <CollapsibleBlock label="Thinking" content="I should check the rules" />
      );
      expect(render('classic', block)).toContain('I should check the rules');
      expect(render('clean', block)).not.toContain('I should check the rules');
    });
  });

  describe('working line', () => {
    it('leaves the time to the header under the clean look', () => {
      const timer = <TurnTimer isStreaming startedAt={Date.now() - 31_000} />;
      expect(render('classic', timer)).toContain('Working… 0:31');
      const clean = render('clean', timer);
      expect(clean).toContain('Thinking');
      expect(clean).not.toContain('0:31');
    });

    it('stays quiet while a step on screen shimmers', () => {
      const timer = <TurnTimer isStreaming liveStatusShown />;
      expect(render('classic', timer)).toContain('Working…');
      expect(render('clean', timer)).not.toContain('turn-timer-label');
    });

    it('draws the live status and the stamp in the step rows’ text', () => {
      const live = render('clean', <TurnTimer isStreaming />);
      expect(live).toContain('data-step-row');
      const now = Date.now();
      const done = render(
        'clean',
        <TurnTimer startedAt={now - 60_000} finishedAt={now - 1_000} />,
      );
      expect(done).toContain('text-s fg-secondary');
      expect(done).not.toContain('fg-quaternary"');
      expect(render('classic', <TurnTimer isStreaming />)).not.toContain(
        'data-step-row',
      );
    });

    it('drops the completed time under the clean look', () => {
      const now = Date.now();
      const timer = (
        <TurnTimer startedAt={now - 60_000} finishedAt={now - 1_000} />
      );
      expect(render('classic', timer)).toContain('Completed in 0:59');
      expect(render('clean', timer)).not.toContain('Completed in');
    });

    it('shimmers the live label instead of showing a spinner', () => {
      const timer = (
        <TurnTimer isStreaming spinner={<span data-testid="spinner" />} />
      );
      expect(render('classic', timer)).toContain('data-testid="spinner"');
      const clean = render('clean', timer);
      expect(clean).not.toContain('data-testid="spinner"');
      expect(clean).toContain('canopy-text-shimmer');
    });
  });

  it('draws app messages as a quiet note', () => {
    const html = renderToStaticMarkup(<ChatAppNote text="Connection lost" />);
    expect(html).toContain('data-testid="chat-app-note"');
    expect(html).toContain('Connection lost');
  });

  it("keeps app errors on the steps' left edge and centers compaction", () => {
    const note = renderToStaticMarkup(<ChatAppNote text="Connection lost" />);
    expect(note).not.toContain('data-chat-notice');
    expect(note).not.toContain('justify-center');
    expect(note).not.toContain('text-center');
    const compaction = render(
      'clean',
      <CompactionInfoBlock
        headline="Claude compacted this session"
        timestamp={Date.UTC(2026, 9, 21, 16, 9)}
      />,
    );
    expect(compaction).toContain('data-chat-notice');
    expect(compaction).toContain('items-center');
    expect(compaction).toContain('text-center');
    expect(compaction).toContain('Claude compacted this session at');
  });

  it('puts Copy message beside the thumbs of a finished reply', () => {
    const finished = (
      <TurnTimer startedAt={1_000} finishedAt={61_000} copyText="Done." />
    );
    // Both looks offer Copy on a finished reply (CAN-4704).
    expect(render('classic', finished)).toContain(
      'data-testid="turn-copy-message"',
    );
    const clean = render('clean', finished);
    expect(clean).toContain('data-testid="turn-copy-message"');
    expect(clean).toContain('aria-label="Copy message"');
    // Nothing to copy while the turn still runs.
    expect(
      render('clean', <TurnTimer startedAt={1_000} copyText="Done." />),
    ).not.toContain('turn-copy-message');
  });

  it('keeps Copy visible while the other finished-turn actions reveal on hover or focus', () => {
    const html = render(
      'clean',
      <TurnTimer
        startedAt={1_000}
        finishedAt={61_000}
        copyText="Done."
        stampAccessory={<TurnFeedbackControl onRate={jest.fn()} />}
        trailing={<ForkChatButton ariaLabel="Fork chat" onClick={jest.fn()} />}
      />,
    );
    const row = html.slice(html.indexOf('data-testid="turn-actions"'));
    expect(row).toContain('gap-0.5 -ml-1.25');
    expect(row.indexOf('aria-label="Copy message"')).toBeLessThan(
      row.indexOf('data-testid="turn-actions-reveal"'),
    );
    expect(row).toContain('opacity-0 group-hover/turn:opacity-100');
    expect(row).toContain('group-focus-within/turn:opacity-100');
    for (const name of [
      'Copy message',
      'Good response',
      'Bad response',
      'Fork chat',
    ])
      expect(row).toContain(`aria-label="${name}"`);
    // One size and ink for every button in the row.
    expect(html).toContain('[&amp;_button]:size-6');
    expect(html).toContain('[&amp;_svg]:size-3.5');
    expect(html).not.toContain('pointer-fine:[&amp;_svg]:size-3');
  });

  it('orders the reply row: Copy, Fork, “•••”, thumbs, then the time', () => {
    const html = render(
      'clean',
      <TurnTimer
        startedAt={1_000}
        finishedAt={Date.UTC(2026, 9, 21, 16, 5)}
        copyText="Done."
        modelLabel="Claude Sonnet 4.5"
        trailing={<ForkChatButton ariaLabel="Fork chat" onClick={jest.fn()} />}
        moreMenu={
          <TurnMoreMenu open={false} onOpenChange={jest.fn()}>
            <span>Branch into a new worktree</span>
          </TurnMoreMenu>
        }
        stampAccessory={<TurnFeedbackControl onRate={jest.fn()} />}
      />,
    );
    const order = [
      'aria-label="Copy message"',
      'aria-label="Fork chat"',
      'aria-label="More actions"',
      'aria-label="Good response"',
      'aria-label="Bad response"',
      'data-testid="turn-timer-relative"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('aria-haspopup="menu"');
    // The model is named with the full date, not as a chip.
    expect(html).not.toContain('turn-auto-model');
  });

  it.each([
    ['failed', 'Failed after'],
    ['cancelled', 'Cancelled after'],
  ] as const)(
    'keeps a %s turn’s outcome in the clean reply row',
    (completionStatus, text) => {
      const timer = (
        <TurnTimer
          startedAt={1_000}
          finishedAt={61_000}
          completionStatus={completionStatus}
          copyText="Partial answer."
        />
      );
      expect(render('clean', timer)).toContain(text);
      expect(render('classic', timer)).toContain(text);
    },
  );

  it('drops “Completed in” from a successful turn’s clean reply row', () => {
    const timer = (
      <TurnTimer startedAt={1_000} finishedAt={61_000} copyText="Done." />
    );
    expect(render('clean', timer)).not.toContain('Completed in');
    expect(render('classic', timer)).toContain('Completed in');
  });

  it('marks thinking with a lightbulb under the clean look only', () => {
    const block = <CollapsibleBlock label="Thinking" content="Plan" running />;
    expect(render('clean', block)).toContain('data-glyph="lightbulb"');
    expect(render('classic', block)).not.toContain('data-glyph="lightbulb"');
    expect(render('clean', <TurnTimer startedAt={1_000} />)).toContain(
      'data-glyph="lightbulb"',
    );
  });

  it('lists Good and Bad response as rows inside the “•••” menu', () => {
    const html = renderToStaticMarkup(
      <TurnFeedbackAsMenuItemsContext.Provider value>
        <TurnFeedbackControl rating="up" onRate={jest.fn()} />
      </TurnFeedbackAsMenuItemsContext.Provider>,
    );
    expect(html).toContain('role="menuitemcheckbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Good response');
    expect(html).toContain('Bad response');
    expect(html).not.toContain('data-testid="turn-feedback-control"');
  });

  it('draws every reply-row and “•••” icon from Lucide', () => {
    const row = render(
      'clean',
      <TurnTimer
        startedAt={1_000}
        finishedAt={61_000}
        copyText="Done."
        trailing={<ForkChatButton ariaLabel="Fork chat" onClick={jest.fn()} />}
        moreMenu={
          <TurnMoreMenu open={false} onOpenChange={jest.fn()}>
            <span />
          </TurnMoreMenu>
        }
      />,
    );
    const menu = renderToStaticMarkup(
      <TurnFeedbackAsMenuItemsContext.Provider value>
        <TurnFeedbackControl onRate={jest.fn()} />
        <GitBranchLineIcon />
      </TurnFeedbackAsMenuItemsContext.Provider>,
    );
    for (const html of [row, menu]) {
      const icons = html.match(/<svg[^>]*>/g) ?? [];
      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons)
        expect(icon).toContain('data-icon-family="lucide"');
    }
    expect(row).toContain('data-glyph="split"');
    expect(row).toContain('data-glyph="ellipsis"');
    expect(menu).toContain('data-glyph="git-branch"');
  });

  it("keeps a running turn's actions in view", () => {
    const live = (
      <TurnTimer
        startedAt={1_000}
        trailing={<button type="button">Watch this chat</button>}
      />
    );
    const html = render('clean', live);
    expect(html).toContain('Watch this chat');
    expect(html).not.toContain('opacity-0 group-hover/turn:opacity-100');
  });

  it("shows a prompt's Copy and Revert in a row under it on hover or focus", () => {
    const bubble = (
      <UserBubble copyText="Add the robot glyph" onRevert={jest.fn()}>
        Add the robot glyph
      </UserBubble>
    );
    const classic = render('classic', bubble);
    expect(classic).toContain('aria-label="Copy to clipboard"');
    expect(classic).toContain('-right-2 -top-2');
    const clean = render('clean', bubble);
    expect(clean).toContain('aria-label="Copy message"');
    expect(clean).toContain('aria-label="Revert this turn"');
    expect(clean).toContain('top-full');
    expect(clean).toContain('group-focus-within:opacity-100');
    expect(clean).not.toContain('-right-2 -top-2');
  });

  it('draws the footer thumbs and fork as plain 14px icons in the text ink', () => {
    const footer = (
      <>
        <TurnFeedbackControl onRate={jest.fn()} />
        <ForkChatButton ariaLabel="Fork chat" onClick={jest.fn()} />
      </>
    );
    const classic = render('classic', footer);
    expect(classic).toContain('fg-quaternary');
    expect(classic).toContain('ring-1');
    const clean = render('clean', footer);
    expect(clean).not.toContain('fg-quaternary');
    expect(clean).not.toContain('ring-1');
    expect(clean).toContain('fg-secondary');
    expect(clean).toContain('width="14px"');
    expect(clean).not.toContain('width="13px"');
  });
});
