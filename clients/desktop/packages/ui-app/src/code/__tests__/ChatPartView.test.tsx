/** @jest-environment jsdom */
import { act } from 'react';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import { createRoot } from 'react-dom/client';
import { describeCleanTurnSteps } from '../clean-turn-steps';
import { renderToString } from 'react-dom/server';
import type {
  PortalAskUserQuestionState,
  PortalChatPart,
} from '@canopy/protocol/portal';
import { CollapsibleBlock } from '@canopy/ui-shared/components';
import { WrenchIcon } from '@canopy/ui-shared/icons';
import { safetyDeniedMessage } from '@canopy/protocol/approvals';
import { ChatToolResultPart } from '../ChatToolResultPart';
import {
  ToolOutputReaderContext,
  type ToolOutputReader,
} from '../DeferredToolOutput';
import {
  ChatPartView,
  ChatWaitingDelegationsContext,
  AskUserQuestionInteractionProvider,
  DeliverableInteractionProvider,
  ModelAccessRecoveryInteractionProvider,
  TurnWorkingStatusProvider,
  type DeliverableInteraction,
  type AskUserQuestionInteraction,
  type ModelAccessRecoveryInteraction,
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
  return renderToString(
    <ChatLookProvider value="classic">
      <ChatPartView part={part} />
    </ChatLookProvider>,
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    <ChatLookProvider value="classic">
      <AskUserQuestionInteractionProvider value={interaction}>
        <ChatPartView part={part} />
      </AskUserQuestionInteractionProvider>
    </ChatLookProvider>,
  );
}

describe('ChatPartView', () => {
  it.each(['classic', 'clean'] as const)(
    'explains error impact with deferred output in the %s look (CAN-5355)',
    async (look) => {
      const read: ToolOutputReader = jest.fn(() =>
        Promise.resolve({
          text: 'EACCES: full failure details',
          byteLength: 28,
        }),
      );
      const part: PortalChatPart = {
        kind: 'tool_use',
        toolFamily: 'write',
        data: {
          toolName: 'Write',
          input: { file_path: '/Users/test/.claude/plans/draft.md' },
          result: {
            output: 'EACCES: preview',
            isError: true,
            outputLocator: {
              kind: 'row',
              messageId: 'plan-failed',
              blockOrdinal: 1,
              field: 'output',
            },
          },
        },
      };
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        act(() => {
          root.render(
            <ChatLookProvider value={look}>
              <ToolOutputReaderContext.Provider value={read}>
                <ChatPartView part={part} />
              </ToolOutputReaderContext.Provider>
            </ChatLookProvider>,
          );
        });
        act(() => {
          container.querySelector<HTMLButtonElement>('button')?.click();
        });
        expect(container.textContent).toContain('draft.md');
        expect(container.textContent).toContain('EACCES: preview');
        expect(
          container.querySelectorAll('[data-testid="tool-call-error-impact"]'),
        ).toHaveLength(1);
        expect(container.textContent).toContain(
          'Effect on the result is unknown',
        );
        const fullOutput = Array.from(
          container.querySelectorAll('button'),
        ).find((button) => button.textContent === 'View full output');
        expect(fullOutput).toBeDefined();
        await act(async () => {
          fullOutput?.click();
          await Promise.resolve();
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('EACCES: full failure details');
        expect(
          container.querySelectorAll('[data-testid="tool-call-error-impact"]'),
        ).toHaveLength(1);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('shows the parent-waiting status only for delegated ids in context', () => {
    const part: PortalChatPart = {
      kind: 'agent',
      data: {
        delegation: {
          delegationId: 'delegate-1',
          parentHarnessId: 'claude',
          description: 'Research the issue',
          prompt: 'Find the cause',
          executionMode: 'foreground',
          status: 'running',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'model-1',
            runtimeModelId: 'model-1',
            harnessId: 'claude',
          },
        },
      },
    };
    const waiting = renderToString(
      <ChatLookProvider value="classic">
        <ChatWaitingDelegationsContext.Provider value={new Set(['delegate-1'])}>
          <ChatPartView part={part} />
        </ChatWaitingDelegationsContext.Provider>
      </ChatLookProvider>,
    );
    const notWaiting = renderToString(
      <ChatLookProvider value="classic">
        <ChatPartView part={part} />
      </ChatLookProvider>,
    );

    expect(waiting).toContain(
      'data-testid="delegated-agent-waiting-on-parent"',
    );
    expect(waiting).toContain('Waiting for the parent');
    expect(notWaiting).not.toContain(
      'data-testid="delegated-agent-waiting-on-parent"',
    );
  });

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

  describe('Codex account model notice (CAN-4716)', () => {
    const raw =
      "Error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
    const part: PortalChatPart = {
      kind: 'text',
      data: {
        text: raw,
        modelAccessFailure: {
          kind: 'model_unsupported',
          model: 'gpt-6.1-sol',
          modelLabel: '6.1 Sol',
          fallbackModel: 'gpt-6-luna',
          fallbackModelLabel: 'Luna 6.0',
        },
      },
    };
    const buttonId = 'portal-chat-codex-account-model-notice-use-fallback';

    it('renders read-only without a provider and hides the raw error', () => {
      const out = html(part);
      expect(out).toContain('portal-chat-codex-account-model-notice');
      expect(out).toContain('can&#x27;t use 6.1 Sol.');
      expect(out).not.toContain('is not supported when using Codex');
      expect(out).not.toContain(buttonId);
    });

    it('ignores a malformed carrier', () => {
      const out = html({
        kind: 'text',
        data: { text: raw, modelAccessFailure: { kind: 'other' } },
      });
      expect(out).toContain('is not supported when using Codex');
      expect(out).not.toContain('portal-chat-codex-account-model-notice');
    });

    it('acts through the provided host interaction', async () => {
      const onUseFallback = jest.fn(() => Promise.resolve());
      const interaction: ModelAccessRecoveryInteraction = {
        canAct: (messageId) => messageId === 'failed-1',
        busyMessageId: null,
        onUseFallback,
      };
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ModelAccessRecoveryInteractionProvider value={interaction}>
            <ChatPartView part={part} messageId="failed-1" />
            <ChatPartView part={part} messageId="history-1" />
          </ModelAccessRecoveryInteractionProvider>,
        );
        await Promise.resolve();
      });
      try {
        const buttons = Array.from(
          container.querySelectorAll<HTMLButtonElement>(
            `[data-testid="${buttonId}"]`,
          ),
        );
        expect(buttons.map((button) => button.disabled)).toEqual([false, true]);
        await act(async () => {
          buttons[0]?.click();
          await Promise.resolve();
        });
        expect(onUseFallback).toHaveBeenCalledWith('failed-1', 'gpt-6-luna');
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    });
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
      <ChatLookProvider value="classic">
        <DeliverableInteractionProvider value={interaction}>
          <ChatPartView part={deliverablePart} />
        </DeliverableInteractionProvider>
      </ChatLookProvider>,
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
    // The default look uses the same lightbulb as the clean chat look.
    expect(out).toContain('data-glyph="lightbulb"');
    expect(out).not.toContain('data-glyph="brain-circuit"');
  });

  it('renders a tool_use part as a tool-call card', () => {
    const out = html({
      kind: 'tool_use',
      data: { toolName: 'Read', input: 'src/a.ts' },
    });
    expect(out).toContain('data-testid="chat-tool-call"');
    expect(out).toContain('Read');
  });

  it('renders a wrapped safety denial as a blocked row without the hook prefix', () => {
    const out = html({
      kind: 'tool_use',
      data: {
        toolName: 'Bash',
        input: JSON.stringify({ command: 'git push --force' }),
        result: {
          output: `PreToolUse:Bash hook error: ${safetyDeniedMessage('force-push')}`,
          isError: true,
        },
      },
    });
    expect(out).toContain('data-tool-status="blocked"');
    expect(out).toContain('Blocked by safety rule');
    expect(out).not.toContain('PreToolUse');
    expect(out).not.toContain('fg-destructive');
  });

  it('keeps a provider error without a known denial message an error', () => {
    const out = html({
      kind: 'tool_use',
      data: {
        toolName: 'Bash',
        result: { output: 'permission denied by sandbox', isError: true },
      },
    });
    expect(out).toContain('data-tool-status="error"');
    expect(out).not.toContain('tool-call-blocked');
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
      <ChatLookProvider value="classic">
        <CollapsibleBlock
          label="Tool result"
          content="done"
          icon={<WrenchIcon />}
        />
      </ChatLookProvider>,
    );
    expect(
      renderToString(
        <ChatLookProvider value="classic">
          <ChatToolResultPart content="done" />
        </ChatLookProvider>,
      ),
    ).toBe(priorRow);
    expect(out).toBe(priorRow);
  });

  it('renders a denied native agent through the shared blocked card', () => {
    const out = html({
      kind: 'agent',
      data: {
        subagentType: 'Explore',
        prompt: 'Inspect',
        isError: true,
        result:
          'PreToolUse:Agent hook error: The user denied this tool call: Keep this local.',
      },
    });
    expect(out).toContain('data-tool-status="blocked"');
    expect(out).toContain('Denied by you');
    expect(out).not.toContain('PreToolUse');
    expect(out).not.toContain('fg-destructive');
  });

  it('excludes a denied native agent from executed work in the clean summary', () => {
    expect(
      describeCleanTurnSteps({
        kind: 'steps',
        key: 'run',
        messages: [
          {
            key: 'agent',
            message: {
              messageId: 'agent',
              chatId: 'c1',
              role: 'assistant',
              status: 'complete',
              text: '',
              createdAtMs: Date.parse('2026-10-24T08:00:00Z'),
              parts: [
                {
                  kind: 'agent',
                  data: {
                    subagentType: 'Explore',
                    isError: true,
                    result: 'The user denied this tool call: Keep this local.',
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toMatchObject({ label: 'No tools ran', blocked: 1, failed: 0 });
  });

  it.each([
    [
      'reads a plan-only write as wrote plan',
      {},
      'Searched once, wrote plan',
      0,
    ],
    [
      'keeps a real Grep failure next to a successful plan write',
      { grep: true },
      'Searched once, wrote plan',
      1,
    ],
    [
      'never claims a failed plan write succeeded',
      { grep: true, plan: true },
      "Searched once, couldn't write plan",
      2,
    ],
  ])(
    '%s (CAN-5355)',
    (_name, failures: { grep?: boolean; plan?: boolean }, label, failed) => {
      const result = (
        isError = false,
      ): { output: string; isError: boolean } => ({
        output: isError ? 'Failed' : 'ok',
        isError,
      });
      expect(
        describeCleanTurnSteps({
          kind: 'steps',
          key: 'run',
          messages: [
            {
              key: 'steps',
              message: {
                messageId: 'steps',
                chatId: 'c1',
                role: 'assistant',
                status: 'complete',
                text: '',
                createdAtMs: 0,
                parts: [
                  {
                    kind: 'tool_use',
                    toolFamily: 'grep',
                    data: {
                      toolUseId: 'grep',
                      toolName: 'Grep',
                      input: { pattern: 'x' },
                      result: result(failures.grep),
                    },
                  },
                  {
                    kind: 'tool_use',
                    toolFamily: 'write',
                    data: {
                      toolUseId: 'plan',
                      toolName: 'Write',
                      input: {
                        file_path: '/Users/test/.claude/plans/draft.md',
                        content: '# Plan',
                      },
                      result: result(failures.plan),
                    },
                  },
                  {
                    kind: 'tool_use',
                    toolFamily: 'write',
                    data: {
                      toolUseId: 'project',
                      toolName: 'Write',
                      input: '{"file_path":"docs/plans/draft.md"}',
                      result: result(),
                    },
                  },
                ],
              },
            },
          ],
        }),
      ).toMatchObject({ label: `${label}, edited 1 file`, failed });
    },
  );

  it.each([
    [undefined, 'Writing plan', 0],
    [{ output: 'EACCES', isError: true }, "Couldn't write plan", 0],
    [
      {
        output: '',
        isError: true,
        interruption: { reason: 'app_restart', at: 1 },
      },
      'Plan write interrupted',
      1,
    ],
  ])(
    'keeps unfinished plan writes status-aware (CAN-5355)',
    (result, label, interrupted) => {
      expect(
        describeCleanTurnSteps({
          kind: 'steps',
          key: 'plan',
          messages: [
            {
              key: 'plan',
              message: {
                messageId: 'plan',
                chatId: 'c1',
                role: 'assistant',
                status: 'streaming',
                text: '',
                createdAtMs: 0,
                parts: [
                  {
                    kind: 'tool_use',
                    toolFamily: 'write',
                    data: {
                      toolUseId: 'plan',
                      toolName: 'Write',
                      input:
                        '{"file_path":"/Users/test/.claude/plans/draft.md"}',
                      result,
                    },
                  },
                ],
              },
            },
          ],
        }),
      ).toMatchObject({ label, interrupted });
    },
  );

  it('counts an interrupted call once and a resultless one only with settled evidence (CAN-5178)', () => {
    const segment: Parameters<typeof describeCleanTurnSteps>[0] = {
      kind: 'steps' as const,
      key: 'run',
      messages: [
        {
          key: 'steps',
          message: {
            messageId: 'steps',
            chatId: 'c1',
            role: 'assistant' as const,
            status: 'complete' as const,
            text: '',
            createdAtMs: 0,
            parts: [
              {
                kind: 'tool_use' as const,
                toolFamily: 'edit',
                data: {
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  input: '{}',
                  result: {
                    output: 'Interrupted',
                    isError: true,
                    interruption: { reason: 'app_restart', at: 1 },
                  },
                },
              },
              {
                kind: 'tool_use' as const,
                toolFamily: 'bash',
                data: { toolUseId: 'bash', toolName: 'Bash', input: '{}' },
              },
            ],
          },
        },
      ],
    };
    expect(describeCleanTurnSteps(segment)).toMatchObject({
      failed: 0,
      interrupted: 1,
    });
    expect(
      describeCleanTurnSteps(segment, {
        settled: true,
        resultsComplete: false,
      }).interrupted,
    ).toBe(1);
    expect(
      describeCleanTurnSteps(segment, { settled: true, resultsComplete: true }),
    ).toMatchObject({ failed: 0, interrupted: 2 });
  });

  it.each([
    { settled: false, resultsComplete: true, isRunning: false, count: 0 },
    { settled: true, resultsComplete: false, isRunning: false, count: 0 },
    { settled: true, resultsComplete: true, isRunning: true, count: 0 },
    { settled: true, resultsComplete: true, isRunning: false, count: 0 },
  ])(
    'keeps independent native-agent outcomes unchanged with parent settlement/completeness $settled/$resultsComplete and running $isRunning',
    ({ settled, resultsComplete, isRunning, count }) => {
      expect(
        describeCleanTurnSteps(
          {
            kind: 'steps',
            key: 'run',
            messages: [
              {
                key: 'agent',
                message: {
                  messageId: 'agent',
                  chatId: 'c1',
                  role: 'assistant',
                  status: 'complete',
                  text: '',
                  createdAtMs: 0,
                  parts: [
                    {
                      kind: 'agent',
                      data: { subagentType: 'Explore', isRunning },
                    },
                  ],
                },
              },
            ],
          },
          { settled, resultsComplete },
        ),
      ).toMatchObject({ interrupted: count, failed: 0, blocked: 0 });
    },
  );

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
      <ChatLookProvider value="classic">
        <ChatPartView
          part={{ kind: 'turn_timer', data: { startedAt: 1000 } }}
          live={false}
        />
      </ChatLookProvider>,
    );
    expect(out).toBe('');
  });

  it('keeps the ticking turn_timer row when the owning message is live', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatPartView
          part={{ kind: 'turn_timer', data: { startedAt: 1000 } }}
          live={true}
        />
      </ChatLookProvider>,
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
        <ChatLookProvider value="classic">
          <ChatPartView
            part={{
              kind: 'turn_timer',
              data: { startedAt: 1000, completedAt: 4000 },
            }}
            terminalStatus={terminalStatus}
          />
        </ChatLookProvider>,
      );
      const [label] = turnTimerLabelClasses(out);
      expect(label).toBeDefined();
      expect(label).not.toContain('opacity-0');
    }
  });

  it('keeps the row visible when turnTimerAlwaysVisible is set', () => {
    const out = renderToString(
      <ChatLookProvider value="classic">
        <ChatPartView
          part={{
            kind: 'turn_timer',
            data: { startedAt: 1000, completedAt: 4000 },
          }}
          turnTimerAlwaysVisible
        />
      </ChatLookProvider>,
    );
    const [label] = turnTimerLabelClasses(out);
    expect(label).toBeDefined();
    expect(label).not.toContain('opacity-0');
    expect(label).not.toContain('group-hover/turn:opacity-100');
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps a recorded timer %s ahead of an interrupted host hint',
    (endReason) => {
      const out = renderToString(
        <ChatLookProvider value="classic">
          <ChatPartView
            terminalStatus="interrupted"
            part={{
              kind: 'turn_timer',
              data: {
                startedAt: 1000,
                completedAt: 15000,
                endReason,
              },
            }}
          />
        </ChatLookProvider>,
      );
      expect(out).toContain(
        endReason === 'failed' ? 'Failed after' : 'Cancelled after',
      );
      expect(out).not.toContain('Interrupted after');
    },
  );

  it('says a projected interrupted timer ended that way, at rest (CAN-5178)', () => {
    const out = html({
      kind: 'turn_timer',
      data: { startedAt: 1000, completedAt: 15_000, endReason: 'interrupted' },
    });
    expect(out).toContain('Interrupted after 0:14');
    expect(out).not.toContain('Completed in');
    expect(turnTimerLabelClasses(out)[0]).not.toContain('opacity-0');
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
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

  it.each(['failed', 'cancelled'] as const)(
    'keeps a Clean footer outcome from persisted endReason %s',
    (endReason) => {
      const out = renderToString(
        <ChatLookProvider value="clean">
          <ChatPartView
            part={{
              kind: 'turn_timer',
              data: { startedAt: 1000, completedAt: 4000, endReason },
            }}
          />
        </ChatLookProvider>,
      );
      expect(out).toContain('data-testid="turn-timer-label"');
      expect(out).toContain(
        endReason === 'failed' ? 'Failed after 0:03' : 'Cancelled after 0:03',
      );
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

  it('renders the interactive card for a Claude unanswered match by question text', () => {
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

  describe('restored answers (CAN-4959)', () => {
    const answeredState: PortalAskUserQuestionState = {
      requestId: 'r-restored',
      questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }],
      answered: true,
      answers: [{ question: 'Pick a color', selectedOptions: ['Blue'] }],
    };

    it('prefers parsed result answers over a different projected answer', () => {
      const out = htmlWith(
        askUserPart({ result: { output: 'Q: Pick a color\nA: Red' } }),
        makeInteraction([answeredState]),
      );
      expect(out).toContain('· Red');
      expect(out).not.toContain('· Blue');
    });

    it('renders result answers without a question projection', () => {
      const out = html(
        askUserPart({ result: { output: 'Q: Pick a color\nA: Red' } }),
      );
      expect(out).toContain('data-testid="answered-questions"');
      expect(out).toContain('· Red');
    });

    it('rerenders from unanswered through accepted, Cancelled and result answers', () => {
      const container = document.createElement('div');
      const root = createRoot(container);
      const show = (
        state: PortalAskUserQuestionState,
        result?: { output: string },
      ): void => {
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <AskUserQuestionInteractionProvider
                value={makeInteraction([state])}
              >
                <ChatPartView part={askUserPart(result ? { result } : {})} />
              </AskUserQuestionInteractionProvider>
            </ChatLookProvider>,
          ),
        );
      };
      try {
        show({ ...answeredState, answered: false, answers: undefined });
        expect(
          container.querySelector('[data-testid="ask-user-question-card"]'),
        ).not.toBeNull();
        for (const result of [
          undefined,
          { output: 'Cancelled' },
          { output: 'Q: Pick a color\nA: Red' },
        ]) {
          show(answeredState, result);
          const row = container.querySelector(
            '[data-tool-name="AskUserQuestion"]',
          );
          expect(row?.getAttribute('data-tool-status')).toBe('success');
          expect(row?.textContent).toContain(
            `· ${result?.output.includes('A: Red') ? 'Red' : 'Blue'}`,
          );
          expect(
            container.querySelector('[data-testid="ask-user-question-card"]'),
          ).toBeNull();
          expect(
            container.querySelector(
              '[data-testid="ask-user-question-preparing"]',
            ),
          ).toBeNull();
          expect(
            container.querySelector('[data-tool-status="pending"]'),
          ).toBeNull();
          expect(
            container.querySelector('[data-testid="answered-questions"]'),
          ).not.toBeNull();
        }
      } finally {
        act(() => root.unmount());
      }
    });

    it('keeps terminal results visible over a stale unanswered projection', () => {
      const out = htmlWith(
        askUserPart({ result: { output: 'Cancelled' } }),
        makeInteraction([
          { ...answeredState, answered: false, answers: undefined },
        ]),
      );
      expect(out).toContain('data-tool-status="success"');
      expect(out).not.toContain('data-testid="ask-user-question-card"');
      expect(out).not.toContain('data-testid="ask-user-question-preparing"');
    });

    it('redacts secret result answers in both the label and body without projection', () => {
      const out = html(
        askUserPart({
          input: JSON.stringify({
            questions: [{ question: 'Token?', secret: true }],
          }),
          result: { output: 'Q: Token?\nA: \nAdditional: sk-live' },
        }),
      );
      expect(out).toContain('· [hidden]');
      expect(out).toContain('data-testid="answered-questions"');
      expect(out).not.toContain('sk-live');
    });

    it('keeps clean-chat answered content settled', () => {
      const out = renderToString(
        <ChatLookProvider value="clean">
          <AskUserQuestionInteractionProvider
            value={makeInteraction([answeredState])}
          >
            <ChatPartView part={askUserPart({})} />
          </AskUserQuestionInteractionProvider>
        </ChatLookProvider>,
      );
      expect(out).toContain('data-testid="answered-questions"');
      expect(out).not.toContain('data-tool-status="pending"');
      expect(out).not.toContain('data-testid="ask-user-question-preparing"');
    });

    it('names the answer in the collapsed row with a settled status', () => {
      const out = htmlWith(askUserPart({}), makeInteraction([answeredState]));
      expect(out).toContain('Asked you 1 question');
      expect(out).toContain('· Blue');
      expect(out).toContain('data-tool-status="success"');
      expect(out).not.toContain('data-tool-status="pending"');
    });

    it('shows the projected answer over a synthetic Cancelled result', () => {
      const out = htmlWith(
        askUserPart({ result: { output: 'Cancelled' } }),
        makeInteraction([answeredState]),
      );
      expect(out).toContain('data-testid="answered-questions"');
      expect(out).toContain('· Blue');
      expect(out).not.toContain('Preparing question');
    });

    it('keeps an error result generic even with an answered projection', () => {
      const out = htmlWith(
        askUserPart({ result: { output: 'Dismissed', isError: true } }),
        makeInteraction([answeredState]),
      );
      expect(out).toContain('data-tool-status="error"');
      expect(out).not.toContain('data-testid="answered-questions"');
    });

    it('settles an answered projection with no answers using the base label', () => {
      const out = htmlWith(
        askUserPart({}),
        makeInteraction([{ ...answeredState, answers: [] }]),
      );
      expect(out).toContain('data-tool-status="success"');
      expect(out).toContain('Asked you 1 question');
      expect(out).not.toContain('Asked you 1 question ·');
      expect(out).not.toContain('data-testid="answered-questions"');
      expect(out).not.toContain('Preparing question');
    });

    it('never shows a secret answer in the row or the answers block', () => {
      const out = htmlWith(
        {
          kind: 'tool_use',
          toolFamily: 'ask-user',
          data: {
            toolName: 'AskUserQuestion',
            input: JSON.stringify({ questions: [{ question: 'Token?' }] }),
          },
        },
        makeInteraction([
          {
            requestId: 'r-secret',
            questions: [
              {
                question: 'Token?',
                options: [],
                secret: true,
                allowOther: true,
              },
            ],
            answered: true,
            answers: [
              {
                question: 'Token?',
                selectedOptions: [],
                freeformText: 'sk-unredacted',
              },
            ],
          },
        ]),
      );
      expect(out).toContain('· [hidden]');
      expect(out).not.toContain('sk-unredacted');
    });

    it('attaches nothing to repeated identical Claude questions', () => {
      const out = htmlWith(
        askUserPart({}),
        makeInteraction([
          answeredState,
          { ...answeredState, requestId: 'r-repeat', answered: false },
        ]),
      );
      expect(out).not.toContain('data-testid="answered-questions"');
      expect(out).not.toContain('data-testid="ask-user-question-card"');
    });
  });

  it('prepares without a result or question projection', () => {
    const out = html(askUserPart({}));
    expect(out).toContain('data-testid="ask-user-question-preparing"');
    expect(out).not.toContain('data-testid="ask-user-question-card"');
    expect(out).not.toContain('data-testid="answered-questions"');
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
      <ChatLookProvider value="classic">
        <TurnWorkingStatusProvider value="Compacting context…">
          <ChatPartView part={part} live />
        </TurnWorkingStatusProvider>
      </ChatLookProvider>,
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
        <ChatLookProvider value="classic">
          <ChatPartView
            part={{
              kind: 'tool_use',
              data: { toolName: 'EnterPlanMode', input: {} },
            }}
          />
        </ChatLookProvider>,
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
