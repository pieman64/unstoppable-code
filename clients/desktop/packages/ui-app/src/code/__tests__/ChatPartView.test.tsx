import { renderToString } from 'react-dom/server';
import type {
  PortalAskUserQuestionState,
  PortalChatPart,
} from '@canopy/protocol/portal';
import { CollapsibleBlock } from '@canopy/ui-shared/components';
import { WrenchIcon } from '@canopy/ui-shared/icons';
import { ChatToolResultPart } from '../ChatToolResultPart';
import {
  ChatPartView,
  AskUserQuestionInteractionProvider,
  DeliverableInteractionProvider,
  TurnWorkingStatusProvider,
  type DeliverableInteraction,
  type AskUserQuestionInteraction,
} from '../ChatPartView';

/** Class list of each rendered `turn-timer` row, in document order. */
function turnTimerRowClasses(markup: string): string[] {
  return markup
    .split(/data-testid="turn-timer" data-state="[a-z]+" class="/)
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('"')));
}

function turnTimerLabelClasses(markup: string): string[] {
  return markup
    .split('data-testid="turn-timer-label" class="')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('"')));
}

function html(part: PortalChatPart): string {
  return renderToString(<ChatPartView part={part} />);
}

const COLOR_INPUT = JSON.stringify({
  questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
});

function makeInteraction(
  states: PortalAskUserQuestionState[],
  overrides: Partial<AskUserQuestionInteraction> = {},
): AskUserQuestionInteraction {
  return {
    states,
    onAnswer: (): void => {},
    onDismiss: (): void => {},
    ...overrides,
  };
}

function htmlWith(
  part: PortalChatPart,
  interaction: AskUserQuestionInteraction | null,
): string {
  return renderToString(
    <AskUserQuestionInteractionProvider value={interaction}>
      <ChatPartView part={part} />
    </AskUserQuestionInteractionProvider>,
  );
}

describe('ChatPartView', () => {
  it('explains the trusted Claude fallback rejection without exposing the raw error', () => {
    const raw = 'API Error: 400 messages.4.content: Invalid input';
    const out = html({
      kind: 'text',
      data: { text: raw, errorCode: 'claude_ai_credits_fallback_rejected' },
    });
    expect(out).toContain('claude-ai-credits-fallback-error');
    expect(out).toContain('Claude is signed out.');
    expect(out).toContain('Sign in to Claude on your computer to continue.');
    expect(out).not.toContain('API Error: 400');
    expect(out).not.toContain('claude-fallback-sign-in');
  });

  it('keeps an unmarked or unknown-code 400 visible', () => {
    for (const errorCode of [undefined, 'unknown_error']) {
      const out = html({
        kind: 'text',
        data: {
          text: 'API Error: 400 messages.4.content: Invalid input',
          errorCode,
        },
      });
      expect(out).toContain('API Error: 400');
      expect(out).not.toContain('claude-ai-credits-fallback-error');
    }
  });

  it.each([false, true])(
    'renders persisted serialized tool results with isError=%s',
    (isError) => {
      const out = html({
        kind: 'tool_use',
        toolFamily: 'graph',
        data: {
          toolName: 'canopy_query_code_graph',
          toolUseId: 'codex-graph-e2e-turn-1',
          input: '{"query":"remote-caller"}',
          result: JSON.stringify({ output: 'Found remote caller', isError }),
        },
      });
      expect(out).toContain(
        `data-tool-status="${isError ? 'error' : 'success'}"`,
      );
    },
  );

  const deliverablePart: PortalChatPart = {
    kind: 'attachment',
    data: {
      text: 'report.pdf',
      deliverable: {
        deliverableId: '22222222-2222-4222-8222-222222222222',
        filename: 'report.pdf',
        sizeBytes: 1536,
        mediaType: 'application/pdf',
        contentSha256: 'a'.repeat(64),
      },
    },
  };

  it('keeps deliverables deploy-safe without a host provider', () => {
    const out = html(deliverablePart);
    expect(out).toContain('report.pdf');
    expect(out).not.toContain('file-deliverable-card');
  });

  it('renders filename, size, and provider-only actions', () => {
    const interaction: DeliverableInteraction = {
      onDownload: (): void => {},
      onOpen: (): void => {},
    };
    const out = renderToString(
      <DeliverableInteractionProvider value={interaction}>
        <ChatPartView part={deliverablePart} />
      </DeliverableInteractionProvider>,
    );
    expect(out).toContain('file-deliverable-card');
    expect(out).toContain('report.pdf');
    expect(out).toContain('1.5 KB');
    expect(out).toContain('Download');
    expect(out).toContain('Open');
  });

  it('renders a thinking part as a collapsible "Thinking" block', () => {
    const out = html({
      kind: 'thinking',
      data: { text: 'reasoning about it' },
    });
    expect(out).toContain('Thinking');
  });

  it('renders a tool_use part as a tool-call card', () => {
    const out = html({
      kind: 'tool_use',
      data: { toolName: 'Read', input: 'src/a.ts' },
    });
    expect(out).toContain('data-testid="chat-tool-call"');
    expect(out).toContain('Read');
  });

  it('derives the tool family from the name when none is provided', () => {
    const out = html({ kind: 'tool_use', data: { toolName: 'Bash' } });
    expect(out).toContain('data-testid="chat-tool-call"');
  });

  it('renders cloud shell reads with file labels and icons when no family is persisted', () => {
    const out = html({
      kind: 'tool_use',
      data: { toolName: 'bash', input: { command: 'cat package.json' } },
    });
    expect(out).toContain('data-tool-name="bash"');
    expect(out).toContain('data-tool-family="read"');
    expect(out).toContain('package.json');
  });

  it('uses read display for a raw command with a stamped shell family', () => {
    const out = html({
      kind: 'tool_use',
      toolFamily: 'bash',
      data: { toolName: 'command', input: 'cat package.json' },
    });
    expect(out).toContain('data-tool-name="command"');
    expect(out).toContain('data-tool-family="read"');
    expect(out).toContain('package.json');
  });

  it('stringifies an object-shaped tool input (persisted-transcript shape)', () => {
    // Persisted transcripts keep `input` as an object; readToolInput stringifies
    // it so the input panel + rich label are not empty.
    const out = html({
      kind: 'tool_use',
      data: { toolName: 'Read', input: { file_path: 'src/a.ts' } },
    });
    expect(out).toContain('data-testid="chat-tool-call"');
  });

  it('renders a tool_result part as a collapsible block', () => {
    const out = html({ kind: 'tool_result', data: { output: 'done' } });
    const priorRow = renderToString(
      <CollapsibleBlock
        label="Tool result"
        content="done"
        icon={<WrenchIcon />}
      />,
    );
    expect(renderToString(<ChatToolResultPart content="done" />)).toBe(
      priorRow,
    );
    expect(out).toBe(priorRow);
  });

  it('renders an agent part as an agent card', () => {
    const out = html({
      kind: 'agent',
      data: { subagentType: 'code-reviewer', prompt: 'review this' },
    });
    expect(out).toContain('data-testid="chat-agent-block"');
    expect(out).toContain('code-reviewer');
  });

  it('accepts recursive sub-blocks (coerced to parts) without error', () => {
    // Sub-blocks render inside the card's expanded panel, so they are not in the
    // collapsed SSR output — this asserts the card renders and coercePart
    // tolerates nested parts (a bad sub-block would throw during render).
    const out = html({
      kind: 'agent',
      data: {
        subagentType: 'general-purpose',
        subBlocks: [
          { kind: 'thinking', data: { text: 'inner thought' } },
          { notAPart: true },
        ],
      },
    });
    expect(out).toContain('data-testid="chat-agent-block"');
    expect(out).toContain('general-purpose');
  });

  it('renders a completed turn_timer', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, completedAt: 4000 },
    });
    expect(out.length).toBeGreaterThan(0);
  });

  it('shows the model Auto picked on a completed turn_timer', () => {
    const out = html({
      kind: 'turn_timer',
      data: {
        startedAt: 1000,
        completedAt: 4000,
        autoRoutedModel: 'claude-haiku-4-5',
        autoRoutedModelLabel: 'Claude Haiku 4.5',
      },
    });
    expect(out).toContain('data-testid="turn-auto-model"');
    expect(out).toContain('Claude Haiku 4.5');
  });

  it('shows the model Auto picked while the turn is still running', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, autoRoutedModel: 'openai/gpt-6-sol' },
    });
    expect(out).toContain('data-testid="turn-auto-model"');
    expect(out).toContain('openai/gpt-6-sol');
  });

  it('shows no model chip on a turn Auto did not route', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, completedAt: 4000 },
    });
    expect(out).not.toContain('data-testid="turn-auto-model"');
  });

  it('renders the inline spinner on a live turn_timer', () => {
    const out = html({ kind: 'turn_timer', data: { startedAt: 1000 } });
    expect(out).toContain('data-testid="turn-timer"');
    expect(out).toContain('aria-label="Thinking"');
  });

  it('renders no spinner on a completed turn_timer', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, completedAt: 4000 },
    });
    expect(out).toContain('data-testid="turn-timer"');
    expect(out).not.toContain('aria-label="Thinking"');
  });

  it('renders nothing for an uncompleted turn_timer on a settled message', () => {
    // An interrupted turn leaves completedAt unset forever; once the owning
    // message is no longer streaming the row must not tick "Working…"
    // (web renderer parity, exact complement of hasLiveTurnTimer).
    const out = renderToString(
      <ChatPartView
        part={{ kind: 'turn_timer', data: { startedAt: 1000 } }}
        live={false}
      />,
    );
    expect(out).toBe('');
  });

  it('keeps the ticking turn_timer row when the owning message is live', () => {
    const out = renderToString(
      <ChatPartView
        part={{ kind: 'turn_timer', data: { startedAt: 1000 } }}
        live={true}
      />,
    );
    expect(out).toContain('data-testid="turn-timer"');
    expect(out).toContain('aria-label="Thinking"');
  });

  // CAN-4278: a successfully completed footer hides as one row at rest and
  // reveals through its turn's `group/turn` scope.
  it('keeps the timestamp and fades the rest of a completed turn_timer row', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, completedAt: 4000 },
    });
    const [row] = turnTimerRowClasses(out);
    const [label] = turnTimerLabelClasses(out);
    expect(row).not.toContain('opacity-0');
    expect(label).toContain('opacity-0');
    expect(label).toContain('group-hover/turn:opacity-100');
    expect(label).toContain('group-focus-within/turn:opacity-100');
    expect(out).toContain('data-testid="turn-timer-relative"');
  });

  it('keeps unsuccessful completed turn_timer rows visible', () => {
    for (const terminalStatus of ['failed', 'cancelled'] as const) {
      const out = renderToString(
        <ChatPartView
          part={{
            kind: 'turn_timer',
            data: { startedAt: 1000, completedAt: 4000 },
          }}
          terminalStatus={terminalStatus}
        />,
      );
      const [label] = turnTimerLabelClasses(out);
      expect(label).toBeDefined();
      expect(label).not.toContain('opacity-0');
    }
  });

  it('keeps the row visible when turnTimerAlwaysVisible is set', () => {
    const out = renderToString(
      <ChatPartView
        part={{
          kind: 'turn_timer',
          data: { startedAt: 1000, completedAt: 4000 },
        }}
        turnTimerAlwaysVisible
      />,
    );
    const [label] = turnTimerLabelClasses(out);
    expect(label).toBeDefined();
    expect(label).not.toContain('opacity-0');
    expect(label).not.toContain('group-hover/turn:opacity-100');
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps a Portal timer with endReason %s visible',
    (endReason) => {
      const out = html({
        kind: 'turn_timer',
        data: { startedAt: 1000, completedAt: 4000, endReason },
      });
      expect(turnTimerLabelClasses(out)[0]).toBeDefined();
      expect(turnTimerLabelClasses(out)[0]).not.toContain('opacity-0');
    },
  );

  it('renders nothing for an empty attachment part', () => {
    expect(html({ kind: 'attachment', data: {} })).toBe('');
  });
});

describe('ChatPartView AskUserQuestion interaction', () => {
  const askUserPart = (data: Record<string, unknown>): PortalChatPart => ({
    kind: 'tool_use',
    toolFamily: 'ask-user',
    data: { toolName: 'AskUserQuestion', input: COLOR_INPUT, ...data },
  });

  it('renders the interactive card for a Claude unanswered match (first unanswered, no toolUseId)', () => {
    const out = htmlWith(
      askUserPart({}),
      makeInteraction([
        {
          requestId: 'r1',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: false,
        },
      ]),
    );
    expect(out).toContain('data-testid="ask-user-question-card"');
    expect(out).toContain('Pick a color');
    expect(out).toContain('Red');
    expect(out).toContain('Blue');
    expect(out).toContain('Send');
    expect(out).toContain('Skip');
  });

  it('matches a Codex dynamic tool_use by exact codex-* toolUseId', () => {
    const out = htmlWith(
      askUserPart({ toolUseId: 'codex-call-1' }),
      makeInteraction([
        {
          requestId: 'r1',
          toolUseId: 'codex-call-1',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: false,
        },
      ]),
    );
    expect(out).toContain('data-testid="ask-user-question-card"');
  });

  it('matches a Codex built-in request_user_input by exact codex-* toolUseId', () => {
    const out = htmlWith(
      {
        kind: 'tool_use',
        toolFamily: 'ask-user',
        data: {
          toolName: 'request_user_input',
          input: COLOR_INPUT,
          toolUseId: 'codex-item-1',
        },
      },
      makeInteraction([
        {
          requestId: 'r1',
          toolUseId: 'codex-item-1',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: false,
        },
      ]),
    );
    expect(out).toContain('data-testid="ask-user-question-card"');
  });

  it('never steals another prompt for a mismatched codex toolUseId', () => {
    const out = htmlWith(
      askUserPart({ toolUseId: 'codex-xyz' }),
      makeInteraction([
        {
          requestId: 'r1',
          toolUseId: 'codex-abc',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: false,
        },
      ]),
    );
    expect(out).not.toContain('data-testid="ask-user-question-card"');
    expect(out).toContain('Preparing question…');
  });

  it('renders Preparing question... when unresolved but no projection has arrived', () => {
    const out = htmlWith(askUserPart({}), makeInteraction([]));
    expect(out).toContain('Preparing question…');
    expect(out).not.toContain('data-testid="ask-user-question-card"');
  });

  it('renders the collapsed tool row plus read-only answer bubbles when answered', () => {
    const out = htmlWith(
      askUserPart({ result: { output: 'Q: Pick a color\nA: Blue' } }),
      makeInteraction([
        {
          requestId: 'r1',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: true,
          answers: [{ question: 'Pick a color', selectedOptions: ['Blue'] }],
        },
      ]),
    );
    expect(out).toContain('data-testid="chat-tool-call"');
    expect(out).toContain('data-testid="answered-questions"');
    expect(out).toContain('Blue');
    expect(out).not.toContain('data-testid="ask-user-question-card"');
  });

  it('renders projected answers when the tool result is a separate message', () => {
    const out = htmlWith(
      askUserPart({}),
      makeInteraction([
        {
          requestId: 'r-separated',
          questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
          answered: true,
          answers: [{ question: 'Pick a color', selectedOptions: ['Blue'] }],
        },
      ]),
    );
    expect(out).toContain('data-testid="answered-questions"');
    expect(out).toContain('Blue');
    expect(out).not.toContain('Preparing question');
    // Explicit success status overrides the null-result pending inference —
    // the tool row must not spin next to an already-answered question.
    expect(out).not.toContain('thinking-dot');
  });

  it('does not attach another Claude answer when ordered question text mismatches', () => {
    const out = htmlWith(
      askUserPart({ result: { output: 'answered' } }),
      makeInteraction([
        {
          requestId: 'other',
          questions: [{ question: 'Pick a size', options: ['S', 'L'] }],
          answered: true,
          answers: [{ question: 'Pick a size', selectedOptions: ['L'] }],
        },
      ]),
    );
    expect(out).not.toContain('data-testid="answered-questions"');
    expect(out).not.toContain('Pick a size');
  });

  it('falls back to the generic tool row when no interaction context exists', () => {
    const out = html(askUserPart({}));
    expect(out).toContain('data-testid="chat-tool-call"');
    expect(out).not.toContain('data-testid="ask-user-question-card"');
    expect(out).not.toContain('Preparing question…');
  });

  it('shows the reconnect helper and disabled controls when disconnected', () => {
    const out = htmlWith(
      askUserPart({}),
      makeInteraction(
        [
          {
            requestId: 'r1',
            questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
            answered: false,
          },
        ],
        { disconnected: true },
      ),
    );
    expect(out).toContain('Reconnect to answer this question.');
    expect(out).toContain('disabled');
  });
});

describe('ChatPartView compaction (REG-2943)', () => {
  it('renders the compaction banner with its time and summary', () => {
    const timestamp = Date.UTC(2026, 8, 9, 10, 11);
    const out = html({
      kind: 'compaction',
      data: {
        occurredAt: timestamp,
        trigger: 'auto',
        summary: 'Kept the plan.',
        tokensBefore: 150000,
        tokensAfter: 20000,
      },
    });
    expect(out).toContain('data-testid="compaction-info-block"');
    expect(out).toContain('Claude compacted this session');
    expect(out).toContain(
      new Date(timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(out).toContain('Kept the plan.');
  });

  it('renders nothing for a compaction without a timestamp', () => {
    expect(html({ kind: 'compaction', data: { trigger: 'auto' } })).toBe('');
  });

  // The projection carries who compacted; the banner must name them the way
  // the desktop transcript does instead of captioning every part as Claude's.
  it('names the provider that compacted, like the desktop transcript', () => {
    const occurredAt = Date.UTC(2026, 8, 9, 10, 11);
    expect(
      html({
        kind: 'compaction',
        data: { occurredAt, provider: 'codex', interfaceMode: 'canopy' },
      }),
    ).toContain('Codex compacted this session');
    expect(
      html({
        kind: 'compaction',
        data: { occurredAt, provider: 'claude', interfaceMode: 'claude-code' },
      }),
    ).toContain('Claude Code compacted this session');
    expect(
      html({
        kind: 'compaction',
        data: { occurredAt, provider: 'claude', interfaceMode: 'canopy' },
      }),
    ).toContain('Claude compacted this session');
    // No provider on the part means a cloud chat, which runs on Claude.
    expect(html({ kind: 'compaction', data: { occurredAt } })).toContain(
      'Claude compacted this session',
    );
    expect(
      html({ kind: 'compaction', data: { occurredAt, provider: 'ollama' } }),
    ).toContain('Context compacted for this session');
  });

  it('shows the host working status on the live turn timer', () => {
    const part: PortalChatPart = {
      kind: 'turn_timer',
      data: { startedAt: 0, completedAt: null },
    };
    const out = renderToString(
      <TurnWorkingStatusProvider value="Compacting context…">
        <ChatPartView part={part} live />
      </TurnWorkingStatusProvider>,
    );
    expect(out).toContain('Compacting context…');
    expect(out).not.toContain('Working…');
    expect(html(part)).toContain('Working…');
  });
});

/**
 * CAN-3019: Canopy deliberately answers `ExitPlanMode` with `behavior: 'deny'`
 * and `interrupt: true` so the plan routes into its own review UI rather than
 * the provider's. Desktop's `ChatBlockRenderer` has always hidden that; the
 * shared transcript (which drives the live Remote Control worktree chat) did
 * not, so the plan surfaced as a failed/rejected tool call.
 */
describe('ChatPartView plan mode', () => {
  const planPart = (
    input: Record<string, unknown>,
    result?: Record<string, unknown>,
  ): PortalChatPart => ({
    kind: 'tool_use',
    data: {
      toolName: 'ExitPlanMode',
      input,
      ...(result ? { result } : {}),
    },
  });

  const DENIAL = {
    isError: true,
    output: 'The user doesn’t want to proceed with this tool use.',
  };

  it('renders the plan markdown and drops the denial result', () => {
    const out = html(planPart({ plan: '# Ship it\n\nStep one.' }, DENIAL));

    expect(out).toContain('Ship it');
    expect(out).toContain('Step one.');
    expect(out).not.toContain('doesn');
    expect(out).not.toContain('ExitPlanMode');
  });

  it('renders nothing for EnterPlanMode', () => {
    expect(
      renderToString(
        <ChatPartView
          part={{
            kind: 'tool_use',
            data: { toolName: 'EnterPlanMode', input: {} },
          }}
        />,
      ),
    ).toBe('');
  });

  /**
   * Desktop returns null here; web prefers an unreadable plan block over a
   * silently missing turn, and the card no longer implies a rejection now that
   * `ExitPlanMode` resolves to the `plan` family.
   */
  it('falls back to the tool card when the input carries no plan', () => {
    const out = html(planPart({ notAPlan: true }, DENIAL));
    expect(out).toContain('ExitPlanMode');
  });

  /**
   * The portal wire caps tool input at 4,000 characters, so a long plan arrives
   * already truncated. Render what arrived — the marker is the honest signal.
   */
  it('renders a wire-truncated plan with its marker', () => {
    const out = html(
      planPart({ plan: 'Body text\n\n[truncated 1234 chars]' }, DENIAL),
    );
    expect(out).toContain('[truncated 1234 chars]');
  });
});

it('renders a native agent running and error state', () => {
  expect(
    html({ kind: 'agent', data: { subagentType: 'Explore', isRunning: true } }),
  ).toContain('aria-label="Thinking"');
  const error = html({
    kind: 'agent',
    data: { subagentType: 'Explore', isError: true },
  });
  expect(error).toContain('>error<');
  expect(error).not.toContain('aria-label="Thinking"');
});
