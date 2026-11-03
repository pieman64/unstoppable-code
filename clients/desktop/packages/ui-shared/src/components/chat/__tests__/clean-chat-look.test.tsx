/**
 * The clean chat look (desktop "Clean chat" Labs experiment). Every shared
 * transcript part must render exactly as before under the classic look, and
 * read as one plain step style under the clean look.
 */
import type { JSX, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_CHAT_DETAIL } from '@canopy/protocol/chat-detail';
import {
  ChatDetailProvider,
  ChatLookProvider,
  type ChatLook,
} from '../../chat-look';
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
import { ToolCallCard, toolCallResultFrom } from '../ToolCallCard';
import {
  safetyDeniedMessage,
  savedRuleDeniedMessage,
  userDeniedMessage,
  POLICY_DENIED_FALLBACK_MESSAGE,
} from '@canopy/protocol/approvals';
import { GitBranchLineIcon } from '../../../icons/AppIcons';
import { TurnMoreMenu } from '../TurnMoreMenu';
import { TurnWorkHeader, formatWorkDuration } from '../TurnWorkHeader';
import { describeStepCounts, describeStepKinds } from '../step-words';
import { getToolDisplayInfo, readableToolInput } from '../tool-display';

// At the default chat detail level; Detailed's badges have their own tests.
function render(look: ChatLook, node: ReactNode): string {
  return renderToStaticMarkup(
    <ChatLookProvider value={look}>
      <ChatDetailProvider value={DEFAULT_CHAT_DETAIL}>
        {node}
      </ChatDetailProvider>
    </ChatLookProvider>,
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
  it('draws every part clean without a provider, since Clean chat graduated', () => {
    const card = (
      <ToolCallCard toolName="Bash" input={BASH_INPUT} status="error" />
    );
    const html = renderToStaticMarkup(card);
    // Without a host's chat detail every step keeps its own row (Detailed).
    expect(html).toBe(
      renderToStaticMarkup(
        <ChatLookProvider value="clean">
          <ChatDetailProvider value="detailed">{card}</ChatDetailProvider>
        </ChatLookProvider>,
      ),
    );
    expect(html).not.toBe(render('classic', card));
    expect(html).not.toContain('fg-destructive');
  });

  it.each(['classic', 'clean'] as const)(
    'names every denial source in the %s look',
    (look) => {
      const cases = [
        [safetyDeniedMessage('force-push'), 'safety rule'],
        [savedRuleDeniedMessage('repository'), 'saved rule'],
        [userDeniedMessage('<b>No.</b>\nNot on this branch.'), 'you'],
        [POLICY_DENIED_FALLBACK_MESSAGE, 'approval system'],
      ];
      for (const [output, source] of cases) {
        const html = render(
          look,
          <ToolCallCard
            toolName="Bash"
            input={BASH_INPUT}
            label={<Label name="Bash" input={BASH_INPUT} />}
            result={toolCallResultFrom({ output, isError: true })}
            defaultCollapsed={false}
          />,
        );
        expect(html).toContain('data-tool-status="blocked"');
        expect(html).toContain(source);
        expect(html).not.toContain('fg-destructive');
        expect(html).not.toContain('tool-call-failed');
        expect(html).not.toContain('<b>No.</b>');
        if (look === 'clean') {
          expect(html).toContain('Run the icon tests');
          expect(html).not.toContain('Couldn’t run');
        }
      }
    },
  );

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

    it.each(['Bash', 'PowerShell'])(
      'keeps the %s description stable across outcomes',
      (toolName) => {
        const draw = (status: 'pending' | 'success' | 'error'): string =>
          render(
            'clean',
            <ToolCallCard
              toolName={toolName}
              input={BASH_INPUT}
              label={<Label name={toolName} input={BASH_INPUT} />}
              status={status}
            />,
          );
        for (const status of ['pending', 'success', 'error'] as const) {
          const html = draw(status);
          expect(html).toContain('Run the icon tests');
          expect(html).not.toContain('npx jest');
          expect(html).toContain(`data-tool-status="${status}"`);
          expect(html.includes('canopy-text-shimmer-strong')).toBe(
            status === 'pending',
          );
        }
        expect(draw('error')).toContain('>Failed<');
      },
    );

    it('keeps a full description without a command and falls back for blank descriptions', () => {
      const description =
        'Check the workspace dependencies and run every selected package test before preparing the review';
      const raw = JSON.stringify({ description });
      expect(render('clean', <Label name="Bash" input={raw} />)).toContain(
        description,
      );
      const blank = JSON.stringify({ command: 'pnpm test', description: '  ' });
      const html = render('clean', <Label name="Bash" input={blank} />);
      expect(html).toContain('Run');
      expect(html).toContain('pnpm test');
    });

    it.each([
      ['Read', { file_path: '/repo/a.ts' }, 'Read'],
      ['Write', { file_path: '/repo/a.ts' }, 'Write'],
      [
        'Edit',
        { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
        'Edit',
      ],
      ['Bash', { command: 'pnpm test' }, 'Run'],
      ['Grep', { pattern: 'needle' }, 'Search for'],
      ['Glob', { pattern: '*.ts' }, 'Find files matching'],
      ['file_change', 'delete: src/a.ts', 'Delete'],
    ])('keeps %s words unchanged from running to done', (name, input, verb) => {
      const raw = typeof input === 'string' ? input : JSON.stringify(input);
      const draw = (status: 'pending' | 'success'): string =>
        render(
          'clean',
          <ToolCallCard
            toolName={name}
            input={raw}
            label={<Label name={name} input={raw} />}
            status={status}
          />,
        );
      const words = (html: string): string => html.replace(/<[^>]+>/g, '');
      expect(words(draw('pending'))).toBe(words(draw('success')));
      expect(words(draw('pending'))).toContain(verb);
    });

    it('keeps descriptions and commands available without repeating them', () => {
      const html = render(
        'clean',
        <ToolCallCard
          toolName="Bash"
          input={BASH_INPUT}
          label={<Label name="Bash" input={BASH_INPUT} />}
          status="success"
          defaultCollapsed={false}
        />,
      );
      expect(html).toContain('Run the icon tests');
      expect(html).toContain('npx jest packages/ui-shared');
      expect(render('classic', bashCard('success'))).toContain(
        'Run the icon tests',
      );
    });

    it('says a blocked command didn’t run and names who blocked it', () => {
      const card = (
        <ToolCallCard
          toolName="Bash"
          input={BASH_INPUT}
          label={<Label name="Bash" input={BASH_INPUT} />}
          result={toolCallResultFrom({
            output: `PreToolUse:Bash hook error: ${safetyDeniedMessage('force-push')}`,
            isError: true,
          })}
        />
      );
      const clean = render('clean', card);
      expect(clean).toContain('data-tool-status="blocked"');
      expect(clean).toContain('Run the icon tests');
      expect(clean).toContain('blocked by safety rule · force-push');
      expect(clean).not.toContain('Ran npx');
      expect(clean).not.toContain('Couldn’t run');
      expect(clean).not.toContain('tool-call-failed');
      const opened = render(
        'clean',
        <ToolCallCard
          toolName="WebFetch"
          input="{}"
          defaultCollapsed={false}
          result={toolCallResultFrom({
            output:
              'PreToolUse:WebFetch hook error: The user denied this tool call: No.',
            isError: true,
          })}
        />,
      );
      expect(opened).toContain('denied by you');
      expect(opened).toContain('The user denied this tool call: No.');
      expect(opened).not.toContain('PreToolUse');
      expect(opened).not.toContain('tool-call-failed');
    });

    it('names a failure in words when the label has no verb for it', () => {
      const card = (
        <ToolCallCard toolName="WebFetch" input="{}" status="error" />
      );
      expect(render('classic', card)).not.toContain('tool-call-failed');
      const clean = render('clean', card);
      expect(clean).toContain('data-testid="tool-call-failed"');
      expect(clean).toContain('>Failed<');
      expect(clean).not.toContain('fg-destructive');
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
      // Host-supplied descriptions also retain a separate failure marker.
      const tensed = failed(getToolDisplayInfo('Bash', BASH_INPUT).label);
      expect(tensed).toContain('Run the icon tests');
      expect(tensed).toContain('data-testid="tool-call-failed"');
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
      expect(render('clean', grep)).toContain('Search for');
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
    it.each([0, 1])(
      'keeps %i hidden calls visible instead of making a summary',
      (count) => {
        const html = render(
          'clean',
          <ChatToolStepGroup summary="Read 1 file" collapsedStepCount={count}>
            <span data-testid="single-call">Read package.json</span>
          </ChatToolStepGroup>,
        );
        expect(html).toContain('single-call');
        expect(html).not.toContain('chat-tool-step-summary');
      },
    );

    it('compacts two calls and reveals only the hidden prefix above recent calls', () => {
      const html = render(
        'clean',
        <ChatToolStepGroup
          summary="Read 2 files"
          collapsedStepCount={2}
          forceExpanded
          hiddenSteps={<span data-testid="hidden-prefix" />}
          liveSteps={<span data-testid="recent-call" />}
        >
          <span data-testid="all-calls" />
        </ChatToolStepGroup>,
      );
      expect(html).toContain('chat-tool-step-summary');
      expect(html).toContain('hidden-prefix');
      expect(html).toContain('recent-call');
      expect(html).not.toContain('all-calls');
      expect(html.indexOf('hidden-prefix')).toBeLessThan(
        html.indexOf('recent-call'),
      );
    });

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

    it('stays one closed line while it runs under the clean look', () => {
      const live = (
        <ChatToolStepGroup
          summary="Ran 2 commands"
          live={{ label: 'Running ls', icon: <span data-testid="live-icon" /> }}
        >
          <span data-testid="group-step" />
        </ChatToolStepGroup>
      );
      const clean = render('clean', live);
      // What the turn does now shimmers in the line, which stays closed.
      expect(clean).not.toContain('group-step');
      expect(clean).toContain('Running ls');
      expect(clean).toContain('live-icon');
      expect(clean).toContain('canopy-text-shimmer');
      expect(clean).not.toContain('Ran 2 commands');
      expect(render('clean', group)).not.toContain('group-step');
    });

    it('joins the shared shimmer sweep instead of restarting it', () => {
      const html = render('clean', <StepRow label="Running ls" running />);
      expect(html).toContain('canopy-text-shimmer-strong');
      expect(html).toMatch(/--canopy-shimmer-delay:-\d+ms/);
      expect(render('clean', <StepRow label="Ran ls" />)).not.toContain(
        '--canopy-shimmer-delay',
      );
    });

    it('says how many steps ran into an error after a finished run', () => {
      const failed = (
        <ChatToolStepGroup summary="Ran 4 commands" failedCount={1}>
          <span />
        </ChatToolStepGroup>
      );
      expect(render('clean', failed)).toContain('· 1 error');
      expect(render('clean', failed)).not.toContain('1 failed');
      expect(render('clean', group)).not.toContain('chat-tool-step-failed');
      const several = (
        <ChatToolStepGroup summary="Ran 4 commands" failedCount={2}>
          <span />
        </ChatToolStepGroup>
      );
      expect(render('clean', several)).toContain('· 2 errors');
    });

    it('says blocked steps before errors and omits zero counts', () => {
      const mixed = render(
        'clean',
        <ChatToolStepGroup
          summary="Ran 3 commands"
          blockedCount={2}
          failedCount={1}
        >
          <span />
        </ChatToolStepGroup>,
      );
      expect(mixed).toContain('· 2 blocked');
      expect(mixed).toContain('· 1 error');
      expect(mixed.indexOf('blocked')).toBeLessThan(mixed.indexOf('1 error'));
      const blockedOnly = render(
        'clean',
        <ChatToolStepGroup summary="Ran 1 command" blockedCount={1}>
          <span />
        </ChatToolStepGroup>,
      );
      expect(blockedOnly).toContain('· 1 blocked');
      expect(blockedOnly).not.toContain('chat-tool-step-failed');
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
      ['interrupted', 'Interrupted after 3m 24s'],
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

    it('waits for the person while the host shows a request (CAN-4996)', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader startedAt={now - 60_000} live waitingForUser />,
      );
      expect(html).toContain('Waiting for you · 1:00');
      expect(html).toContain('data-turn-header="paused"');
      expect(html).not.toContain('Working for');
    });

    it('keeps a recorded pause when the host has nothing waiting', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader
          startedAt={now - 60_000}
          pausedAt={now - 30_000}
          live
          waitingForUser={false}
        />,
      );
      expect(html).toContain('data-turn-header="paused"');
    });

    it('lets a finished turn win over a stale waiting flag', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader
          startedAt={now - 60_000}
          finishedAt={now - 30_000}
          live
          waitingForUser
        />,
      );
      expect(html).toContain('Worked for 30s');
      expect(html).toContain('data-turn-header="done"');
    });

    it('includes frozen active time for a projected block pause', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader
          startedAt={now - 90_000}
          pausedAt={now - 20_000}
          accumulatedPausedDurationMs={5_000}
          live
        />,
      );
      expect(html).toContain('Waiting for you · 1:05');
      expect(html).toContain('data-turn-header="paused"');
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
      expect(
        renderToStaticMarkup(
          <TurnWorkHeader elapsedMs={14_000} completionStatus="interrupted" />,
        ),
      ).toContain('Interrupted after 14s');
      expect(
        renderToStaticMarkup(
          <TurnWorkHeader elapsedMs={0} completionStatus="interrupted" />,
        ),
      ).toContain('Interrupted after 0s');
    });

    it('announces a just-submitted turn once, without a ticking time', () => {
      const html = renderToStaticMarkup(
        <TurnWorkHeader
          starting
          startedAt={now - 28_000}
          expandable
          dataTestId="turn-starting-status"
        />,
      );
      expect(html).toContain('Starting…');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('data-turn-header="starting"');
      expect(html).toContain('data-testid="turn-starting-status"');
      expect(html).not.toContain('28s');
      expect(html).not.toContain('aria-expanded');
      // A working spinner before the words, silent so the status reads once,
      // and no hairline under a header that has no steps to close yet.
      expect(html).toContain('data-testid="turn-starting-spinner"');
      expect(html).not.toContain('aria-label="Loading"');
      expect(html.indexOf('turn-starting-spinner')).toBeLessThan(
        html.indexOf('Starting…'),
      );
      expect(html).not.toContain('border-b');
      expect(
        renderToStaticMarkup(<TurnWorkHeader startedAt={now - 28_000} live />),
      ).toContain('border-b');
      expect(
        renderToStaticMarkup(<TurnWorkHeader startedAt={now - 28_000} live />),
      ).not.toContain('role="status"');
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
    it.each(['classic', 'clean'] as const)(
      'shows a denied native agent as blocked in the %s look',
      (look) => {
        const html = render(
          look,
          <AgentBlockCard
            subagentType="Explore"
            description="Inspect the repository"
            prompt="Find the implementation"
            result={`PreToolUse:Agent hook error: ${userDeniedMessage('Keep this local.')}`}
            isError
          />,
        );
        expect(html).toContain('data-tool-status="blocked"');
        expect(html).toContain(
          look === 'clean' ? 'denied by you' : 'Denied by you',
        );
        expect(html).not.toContain('fg-destructive');
        expect(html).not.toContain('PreToolUse');
        expect(html).not.toContain('>failed<');
        expect(html).not.toContain('>error<');
      },
    );

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
      expect(render('clean', failed)).toContain('>Failed<');
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
    it('leaves the time to the header and the status to the transcript', () => {
      const timer = <TurnTimer isStreaming startedAt={Date.now() - 31_000} />;
      expect(render('classic', timer)).toContain('Working… 0:31');
      const clean = render('clean', timer);
      // The transcript's live line says what the turn does, so the row never
      // swaps a label in and out beside its actions.
      expect(clean).not.toContain('turn-timer-label');
      expect(clean).not.toContain('0:31');
    });

    it('draws the stamp in the step rows’ text', () => {
      const now = Date.now();
      const done = render(
        'clean',
        <TurnTimer startedAt={now - 60_000} finishedAt={now - 1_000} />,
      );
      expect(done).toContain('text-s fg-secondary');
      expect(done).not.toContain('fg-quaternary"');
    });

    it('drops the completed time under the clean look', () => {
      const now = Date.now();
      const timer = (
        <TurnTimer startedAt={now - 60_000} finishedAt={now - 1_000} />
      );
      expect(render('classic', timer)).toContain('Completed in 0:59');
      expect(render('clean', timer)).not.toContain('Completed in');
    });

    it('drops the spinner under the clean look', () => {
      const timer = (
        <TurnTimer isStreaming spinner={<span data-testid="spinner" />} />
      );
      expect(render('classic', timer)).toContain('data-testid="spinner"');
      expect(render('clean', timer)).not.toContain('data-testid="spinner"');
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

  it('puts every finished-turn action in one row that is always in view', () => {
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
    // Never hidden until hover: Copy, the rest of the row and the time
    // all show at rest.
    expect(html).not.toContain('opacity-0');
    expect(row).toContain('class="flex items-center gap-0.5 -ml-1.75"');
    expect(row.indexOf('aria-label="Copy message"')).toBeLessThan(
      row.indexOf('data-testid="turn-actions-reveal"'),
    );
    for (const name of [
      'Copy message',
      'Good response',
      'Bad response',
      'Fork chat',
    ])
      expect(row).toContain(`aria-label="${name}"`);
    // One button for every action in the row: the shared ghost capsule.
    expect(
      row.match(/bg-transparent fg-tertiary hover:bg-subtle/g),
    ).toHaveLength(4);
    expect(html).not.toContain('[&amp;_button]:size-6');
    expect(html).toContain('[&amp;_svg]:size-3.5');
    expect(html).not.toContain('pointer-fine:[&amp;_svg]:size-3');
  });

  it('draws the reply row a step quieter, the time in the small caption style', () => {
    const html = render(
      'clean',
      <TurnTimer
        startedAt={1_000}
        finishedAt={61_000}
        copyText="Done."
        trailing={<ForkChatButton ariaLabel="Fork chat" onClick={jest.fn()} />}
      />,
    );
    const row = html.slice(html.indexOf('data-testid="turn-actions"'));
    // Tertiary ink at rest, primary on hover, the same 28px capsule.
    expect(
      row.match(/fg-tertiary hover:bg-subtle hover:fg-primary/g),
    ).toHaveLength(2);
    expect(row).toContain('h-7 rounded-full');
    const stamp = html.slice(html.indexOf('data-testid="turn-timer-relative"'));
    expect(stamp).toMatch(/class="[^"]*text-xs[^"]*fg-tertiary/);
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
    ['interrupted', 'Interrupted after'],
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

  it('shows "Thinking" in a running row whose host sends no live line', () => {
    // A host such as the Portal mounts the timer alone: the row still says
    // the turn is working.
    const html = render('clean', <TurnTimer startedAt={1_000} isStreaming />);
    expect(html).toContain('Thinking');
    expect(html).toContain('canopy-text-shimmer-strong');
    // A host that shows the step itself leaves the slot empty on purpose.
    const empty = render(
      'clean',
      <TurnTimer startedAt={1_000} isStreaming liveLine={null} />,
    );
    expect(empty).not.toContain('Thinking');
  });

  it.each(['detailed', 'recent', 'compact'] as const)(
    'matches a %s thinking row to a tool row’s typography without an icon',
    (detail) => {
      const thinking = render(
        'clean',
        <ChatDetailProvider value={detail}>
          <TurnTimer startedAt={1000} isStreaming />
        </ChatDetailProvider>,
      );
      const tool = render(
        'clean',
        <ChatDetailProvider value={detail}>
          <ToolCallCard
            toolName="Bash"
            label="Run the unit tests"
            status="success"
          />
        </ChatDetailProvider>,
      );
      const rowClass = (html: string): string | undefined =>
        /class="([^"]*)"/.exec(
          /<(?:div|button)\b[^>]*data-step-row=""[^>]*>/.exec(html)?.[0] ?? '',
        )?.[1];
      expect(rowClass(thinking)).toContain('text-s');
      expect(rowClass(tool)).toContain('text-s');
      expect(thinking).not.toContain('data-glyph="lightbulb"');
      expect(rowClass(thinking)).not.toContain('pl-5.5');
    },
  );

  it('omits the thinking icon in clean chat and preserves the classic look', () => {
    const block = <CollapsibleBlock label="Thinking" content="Plan" running />;
    expect(render('clean', block)).not.toContain('data-glyph="lightbulb"');
    expect(render('clean', block)).not.toContain('pl-5.5');
    expect(render('classic', block)).toContain('data-glyph="lightbulb"');
    expect(render('classic', block)).not.toContain(
      'data-glyph="brain-circuit"',
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

  it("keeps a running turn's actions in view in its header", () => {
    const live = (
      <TurnTimer
        startedAt={1_000}
        trailing={<button type="button">Watch this chat</button>}
        liveLine={<span data-testid="live-line" />}
      />
    );
    const html = render('clean', live);
    // The row under the reply is the live line's slot while the turn runs;
    // its actions ride in the header, always in view.
    expect(html).toContain('live-line');
    expect(html).not.toContain('Watch this chat');
    const header = render(
      'clean',
      <TurnWorkHeader
        startedAt={1_000}
        live
        trailing={<button type="button">Watch this chat</button>}
      />,
    );
    expect(header).toContain('Watch this chat');
    expect(header).not.toContain('opacity-0 group-hover/turn:opacity-100');
  });

  it("keeps a prompt's Copy and Revert on the bubble's corner, as classic", () => {
    const bubble = (
      <UserBubble copyText="Add the robot glyph" onRevert={jest.fn()}>
        Add the robot glyph
      </UserBubble>
    );
    // Same placement, badges and hover reveal as the default look: nothing
    // hangs under the bubble beside the turn's "Worked for" line.
    expect(render('clean', bubble)).toBe(render('classic', bubble));
    expect(render('clean', bubble)).toContain('-right-2 -top-2');
    expect(render('clean', bubble)).not.toContain('top-full');
    // Tabbing to Copy or Revert reveals the badges, as hovering does.
    expect(render('clean', bubble)).toContain(
      'group-hover:opacity-100 group-focus-within:opacity-100',
    );
  });

  it('draws the footer thumbs and fork as plain 14px icons in the quiet ink', () => {
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
    expect(clean).toContain('fg-tertiary hover:bg-subtle hover:fg-primary');
    expect(clean).toContain('width="14px"');
    expect(clean).not.toContain('width="13px"');
  });
});
