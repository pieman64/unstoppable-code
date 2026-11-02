/**
 * Server-rendered tests for the shared {@link ToolCallCard}. Validates that
 * tool-family icon dispatch picks the right SVG, that the pending/success/
 * error status surfaces the right affordances, and that the default
 * collapsed/expanded states render the right body chrome.
 */
import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';
import {
  safetyDeniedMessage,
  userDeniedMessage,
} from '@canopy/protocol/approvals';
import { ChatAppNameProvider, ChatLookProvider } from '../../chat-look';
import {
  ToolCallCard,
  ToolCallResultSection,
  interruptedToolCallResult,
  readToolCallResult,
  toolCallResultFrom,
  toolCallResultHeading,
} from '../ToolCallCard';
import {
  NO_TOOL_APPROVAL_WAIT,
  ToolApprovalWaitProvider,
  type ToolApprovalWait,
} from '../tool-approval-wait';
import { getToolDisplayInfo } from '../tool-display';

const SAFETY = safetyDeniedMessage('force-push');
const WRAPPED_SAFETY = `PreToolUse:Bash hook error: ${SAFETY}`;

describe('failure output impact (CAN-5355)', () => {
  it.each(['classic', 'clean'] as const)(
    'explains unknown impact in an expanded %s tool row',
    (look) => {
      const html = renderToString(
        <ChatLookProvider value={look}>
          <ToolCallCard
            toolName="Write"
            label="Write draft.md"
            result={{ kind: 'error', content: 'EACCES' }}
            defaultCollapsed={false}
          />
        </ChatLookProvider>,
      );
      expect(html).toContain('Write draft.md');
      expect(html).toContain('EACCES');
      expect(html).toContain('Effect on the result is unknown');
    },
  );
});

describe('readToolCallResult', () => {
  it.each([false, true])(
    'preserves live and persisted isError=%s results',
    (isError) => {
      const raw = { output: 'Tool output', isError };
      const expected = {
        kind: isError ? 'error' : 'text',
        content: raw.output,
      };
      expect(readToolCallResult(raw)).toEqual(expected);
      expect(readToolCallResult(JSON.stringify(raw))).toEqual(expected);
    },
  );

  it('keeps alias priority, empty output, and strict error booleans', () => {
    expect(
      readToolCallResult({ output: '', content: 'fallback', isError: 'true' }),
    ).toEqual({ kind: 'text', content: '' });
    expect(
      readToolCallResult(
        JSON.stringify({ output: null, content: 'Content', text: 'Text' }),
      ),
    ).toEqual({ kind: 'text', content: 'Content' });
    expect(readToolCallResult({ text: 'Text' })).toEqual({
      kind: 'text',
      content: 'Text',
    });
  });

  it.each([
    undefined,
    null,
    42,
    [],
    {},
    'not JSON',
    'null',
    '[]',
    '42',
    '{"output":42}',
    '"plain text"',
  ])('leaves an invalid result unresolved: %p', (value) => {
    expect(readToolCallResult(value)).toBeNull();
  });
});

describe('toolCallResultFrom', () => {
  it('reads a wrapped denial as blocked, with the wrapper removed', () => {
    const result = toolCallResultFrom({
      output: WRAPPED_SAFETY,
      isError: true,
    });
    expect(result).toMatchObject({ kind: 'blocked', content: SAFETY });
    expect(toolCallResultHeading(result)).toBe('Blocked by safety rule');
    expect(
      readToolCallResult({ output: WRAPPED_SAFETY, isError: true }),
    ).toEqual(result);
    expect(
      readToolCallResult(
        JSON.stringify({ output: WRAPPED_SAFETY, isError: true }),
      ),
    ).toEqual(result);
  });

  it('keeps an unknown hook failure an error, without its wrapper', () => {
    const result = toolCallResultFrom({
      output: 'PreToolUse:Bash hook error: hook crashed',
      isError: true,
    });
    expect(result).toEqual({ kind: 'error', content: 'hook crashed' });
    expect(toolCallResultHeading(result)).toBe('Error');
  });

  it('leaves successful output alone even when it repeats denial text', () => {
    expect(
      toolCallResultFrom({ output: WRAPPED_SAFETY, isError: false }),
    ).toEqual({ kind: 'text', content: WRAPPED_SAFETY });
  });
});

describe('blocked ToolCallCard', () => {
  const blocked = toolCallResultFrom({ output: WRAPPED_SAFETY, isError: true });
  const userDenied = toolCallResultFrom({
    output: `PreToolUse:Bash hook error: ${userDeniedMessage('Not on this branch.')}`,
    isError: true,
  });

  it('marks the row blocked, names the source, and drops error styling', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={blocked}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="blocked"');
    expect(html).toContain('Blocked by safety rule');
    expect(html).toContain(SAFETY);
    expect(html).not.toContain('PreToolUse');
    expect(html).not.toContain('fg-destructive');
    expect(html).toContain('fg-attention');
    expect(html).not.toMatch(/>Error</);
  });

  it('lets a blocked result override an explicit error status', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard toolName="Bash" result={blocked} status="error" />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="blocked"');
  });

  it('keeps the typed reason in a user denial', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolName="Bash"
          result={userDenied}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('Denied by you');
    expect(html).toContain(
      'The user denied this tool call: Not on this branch.',
    );
  });
});

describe('ToolCallCard', () => {
  it('renders the supplied tool name as the default label', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard toolFamily="read" toolName="Read" />
      </ChatLookProvider>,
    );
    expect(html).toContain('Read');
    expect(html).toContain('data-tool-family="read"');
  });

  it('falls back to the wrench icon when toolFamily is missing', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard toolName="UnknownTool" />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="unknown"');
  });

  it('renders a custom label when provided', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          label={<span data-testid="rich-label">npm test</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="rich-label"');
    expect(html).toContain('npm test');
  });

  it('shows the pending spinner slot while no result is set', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          pendingSpinner={<span data-testid="spinner">…</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="spinner"');
  });

  it('nudges the pending spinner up to align with the label text', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          pendingSpinner={<span data-testid="spinner">…</span>}
        />
      </ChatLookProvider>,
    );
    const spinnerWrapperClass = html.match(
      /<span class="([^"]*)"><span data-testid="spinner"/,
    )?.[1];

    expect(spinnerWrapperClass?.split(/\s+/)).toContain('-translate-y-px');
  });

  it('hides the pending spinner once result is set', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={{ kind: 'text', content: 'ok' }}
          pendingSpinner={<span data-testid="spinner">…</span>}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('data-testid="spinner"');
  });

  it('tints the icon red when result is an error', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={{ kind: 'error', content: 'boom' }}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('fg-destructive');
  });

  /**
   * CAN-5056: the icon's error tint swaps to +/− on hover, so the classic row
   * also says "error" in words, and keeps saying it while hovered.
   */
  it('names an errored row in words that stay while hovered', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={{ kind: 'error', content: 'boom' }}
        />
      </ChatLookProvider>,
    );
    const word =
      /<span class="([^"]*)" data-testid="tool-call-error">error<\/span>/.exec(
        html,
      );
    expect(word).not.toBeNull();
    expect(word?.[1]).toContain('fg-destructive');
    expect(word?.[1]).not.toMatch(/group-hover|hidden/);
    expect(html).not.toContain('tool-call-failed');
  });

  it('says no error word for a successful or blocked row', () => {
    expect(
      renderToString(
        <ChatLookProvider value="classic">
          <ToolCallCard
            toolName="Bash"
            result={{ kind: 'text', content: 'ok' }}
          />
        </ChatLookProvider>,
      ),
    ).not.toContain('tool-call-error');
    expect(
      renderToString(
        <ChatLookProvider value="classic">
          <ToolCallCard
            toolName="Bash"
            result={toolCallResultFrom({
              output: WRAPPED_SAFETY,
              isError: true,
            })}
            status="error"
          />
        </ChatLookProvider>,
      ),
    ).not.toContain('tool-call-error');
  });

  it('tints the Error heading of an opened error result', () => {
    const heading = (
      result: Parameters<typeof ToolCallCard>[0]['result'],
    ): string | undefined =>
      /class="([^"]*)" data-testid="tool-call-result-heading"/.exec(
        renderToString(
          <ChatLookProvider value="classic">
            <ToolCallCard
              toolName="Bash"
              result={result}
              defaultCollapsed={false}
            />
          </ChatLookProvider>,
        ),
      )?.[1];
    expect(heading({ kind: 'error', content: 'boom' })).toContain(
      'fg-destructive',
    );
    expect(heading({ kind: 'text', content: 'ok' })).not.toContain(
      'fg-destructive',
    );
  });

  it('keeps an opened clean error result colorless', () => {
    const html = renderToString(
      <ChatLookProvider value="clean">
        <ToolCallCard
          toolName="Bash"
          result={{ kind: 'error', content: 'boom' }}
          defaultCollapsed={false}
          expandedSlot={
            <ToolCallResultSection
              result={{ kind: 'error', content: 'boom' }}
            />
          }
        />
      </ChatLookProvider>,
    );
    const heading =
      /class="([^"]*)" data-testid="tool-call-result-heading"/.exec(html);
    expect(heading).not.toBeNull();
    expect(heading?.[1]).not.toContain('fg-destructive');
  });

  it('renders the expanded body when defaultCollapsed=false', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          input="npm run build"
          result={{ kind: 'text', content: 'ok' }}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('npm run build');
    expect(html).toContain('Result');
    expect(html).toContain('ok');
  });

  it('does not render the body by default', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          input="npm run build"
          result={{ kind: 'text', content: 'ok' }}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('npm run build');
  });

  it('uses the expanded slot override when supplied', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="web"
          toolName="WebFetch"
          defaultCollapsed={false}
          expandedSlot={<div data-testid="custom-slot">prompt</div>}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="custom-slot"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="read"
          toolName="Read"
          dataTestId="tool-call"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-testid="tool-call"');
  });

  it('exposes the raw canonical tool name and pending status on the root', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolName="mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs"
          dataTestId="chat-tool-call"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain(
      'data-tool-name="mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs"',
    );
    expect(html).toContain('data-tool-status="pending"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('derives data-tool-status="success" from a text result', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={{ kind: 'text', content: 'ok' }}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="success"');
  });

  it('derives data-tool-status="error" from an error result', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          result={{ kind: 'error', content: 'boom' }}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="error"');
  });

  it('honors an explicit status override on the root attribute', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard toolFamily="bash" toolName="Bash" status="error" />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="error"');
  });

  it('expands an error result beneath the Error heading', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="bash"
          toolName="Bash"
          input="npm run build"
          result={{ kind: 'error', content: 'gateway timeout' }}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('npm run build');
    expect(html).toContain('Error');
    expect(html).not.toContain('>Result<');
    expect(html).toContain('gateway timeout');
  });

  it('uses the supplied app icon for app-family tools', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="canopy"
          toolName="DispatchAction"
          appIcon={<svg data-testid="brand-app-icon" />}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="canopy"');
    expect(html).toContain('data-testid="brand-app-icon"');
  });
});

describe('Code Graph tool results through the generic card', () => {
  const toolName = 'mcp__canopy__QueryCodeGraph';
  const errorMessage = 'Code Graph is busy. Try again in a moment.';
  const errorContent = `{"ok":false,"code":"internal","message":"${errorMessage}"}`;

  it('shows a Code Graph error as raw generic result text without invented metrics', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="graph"
          toolName={toolName}
          result={{ kind: 'error', content: errorContent }}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-tool-family="graph"');
    expect(html).toContain('data-tool-status="error"');
    expect(html).toContain(`data-tool-name="${toolName}"`);
    expect(html).toContain('>Error<');
    expect(html).not.toContain('>Result<');
    expect(html).toContain(errorMessage);
    expect(html).not.toContain('0 files');
    expect(html).not.toContain('>Files<');
    expect(html).not.toContain('>Symbols<');
    expect(html).not.toContain('Edges');
  });

  it('does not render the error body into the markup when collapsed by default', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="graph"
          toolName={toolName}
          result={{ kind: 'error', content: errorContent }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-tool-status="error"');
    expect(html).not.toContain(errorMessage);
  });

  it('renders Code Graph text results verbatim under the Result heading', () => {
    const content = 'Code Graph: 12 file(s), 34 symbol(s)';
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolFamily="graph"
          toolName={toolName}
          result={{ kind: 'text', content }}
          defaultCollapsed={false}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('>Result<');
    expect(html).toContain(content);
  });

  it('anchors the call for a transcript reveal in either look', () => {
    for (const look of ['classic', 'clean'] as const) {
      const html = renderToString(
        <ChatLookProvider value={look}>
          <ToolCallCard toolName="Monitor" toolUseId="toolu-monitor" />
        </ChatLookProvider>,
      );
      expect(html).toContain('data-tool-use-id="toolu-monitor"');
    }
  });
});

describe('interrupted tool calls (CAN-4897)', () => {
  const restart = { reason: 'app_restart' as const, at: 180 };

  it('lets explicit interruption metadata outrank the error flag', () => {
    const result = toolCallResultFrom({
      output: 'Interrupted by app restart',
      isError: true,
      interruption: restart,
    });
    expect(result.kind).toBe('interrupted');
    expect(toolCallResultHeading(result)).toBe('Interrupted');
    expect(
      readToolCallResult({
        output: 'Interrupted by app restart',
        isError: true,
        interruption: restart,
      })?.kind,
    ).toBe('interrupted');
  });

  it('never infers interruption from output text alone', () => {
    expect(readToolCallResult({ output: 'Cancelled', isError: false })).toEqual(
      { kind: 'text', content: 'Cancelled' },
    );
    expect(
      readToolCallResult({
        output: 'Interrupted by app restart',
        isError: true,
      })?.kind,
    ).toBe('error');
    expect(
      readToolCallResult({
        output: 'x',
        isError: true,
        interruption: { reason: 'bogus', at: 1 },
      })?.kind,
    ).toBe('error');
  });

  it.each(['classic', 'clean'] as const)(
    'renders the %s look as interrupted with the app name for a known restart',
    (look) => {
      const html = renderToString(
        <ChatLookProvider value={look}>
          <ChatAppNameProvider value="Canopy">
            <ToolCallCard
              toolName="Edit"
              input='{"file_path":"a.ts"}'
              result={interruptedToolCallResult(restart)}
            />
          </ChatAppNameProvider>
        </ChatLookProvider>,
      );
      expect(html).toContain('data-tool-status="interrupted"');
      expect(html).toContain('data-tool-interruption="app_restart"');
      expect(html).toContain('Interrupted when Canopy closed');
      expect(html).not.toContain('data-testid="tool-call-failed"');
    },
  );

  it('says only "Interrupted" when the reason is unknown', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ChatAppNameProvider value="Canopy">
          <ToolCallCard toolName="Bash" result={interruptedToolCallResult()} />
        </ChatAppNameProvider>
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-interruption="unknown"');
    expect(html).toContain('>Interrupted<');
    expect(html).not.toContain('closed');
  });

  it('explains that no result was recorded without claiming a rollback', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard
          toolName="Edit"
          defaultCollapsed={false}
          result={interruptedToolCallResult(restart)}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('No result was recorded.');
    expect(html).toContain('still in place');
  });

  it('keeps a call with no result pending', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolCallCard toolName="Edit" result={null} />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-status="pending"');
    expect(html).not.toContain('data-tool-interruption');
  });
});

describe('ToolCallCard waiting for approval (CAN-5291)', () => {
  const bash = JSON.stringify({ command: 'pnpm test' });
  const waitAll: ToolApprovalWait = {
    isCallWaiting: () => true,
    isFileWaiting: () => true,
  };
  const renderClean = (
    card: JSX.Element,
    wait: ToolApprovalWait = NO_TOOL_APPROVAL_WAIT,
  ): string =>
    renderToString(
      <ChatLookProvider value="clean">
        <ToolApprovalWaitProvider value={wait}>{card}</ToolApprovalWaitProvider>
      </ChatLookProvider>,
    );

  it.each([
    ['Read', { file_path: '/repo/src/a.ts' }, 'Waiting to read'],
    [
      'Write',
      { file_path: '/repo/notes.md', content: 'x' },
      'Waiting to write',
    ],
    [
      'Edit',
      { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
      'Waiting to edit',
    ],
    ['Bash', { command: 'pnpm test' }, 'Waiting to run'],
    ['Grep', { pattern: 'approval' }, 'Waiting to search for'],
    ['Glob', { pattern: '*.ts' }, 'Waiting to find files matching'],
  ])('says %s waits, without shimmer', (toolName, input, verb) => {
    const raw = JSON.stringify(input);
    const html = renderClean(
      <ToolCallCard
        toolName={toolName}
        label={getToolDisplayInfo(toolName, raw).label}
        input={raw}
        toolUseId="call-1"
      />,
      waitAll,
    );
    expect(html).toContain(verb);
    expect(html).toContain('data-tool-status="pending"');
    expect(html).toContain('data-tool-approval="waiting"');
    expect(html).not.toContain('canopy-text-shimmer');
    expect(html).not.toContain('tool-call-waiting');
  });

  it('keeps the running presentation once approval clears', () => {
    const html = renderClean(
      <ToolCallCard
        toolName="Bash"
        label={getToolDisplayInfo('Bash', bash).label}
        input={bash}
      />,
    );
    expect(html).toContain('Running');
    expect(html).toContain('canopy-text-shimmer-strong');
    expect(html).not.toContain('data-tool-approval');
  });

  it('names the wait beside a label without a verb', () => {
    const html = renderClean(
      <ToolCallCard toolName="mcp__linear__create_issue" input="{}" />,
      waitAll,
    );
    expect(html).toContain('data-testid="tool-call-waiting"');
    expect(html).toContain('Waiting for approval');
    expect(html).not.toContain('canopy-text-shimmer');
  });

  it('lets an explicit override win over the provider either way', () => {
    const off = renderClean(
      <ToolCallCard toolName="Bash" input={bash} awaitingApproval={false} />,
      waitAll,
    );
    expect(off).not.toContain('data-tool-approval');
    expect(off).toContain('canopy-text-shimmer-strong');
    const on = renderClean(
      <ToolCallCard toolName="Bash" input={bash} awaitingApproval />,
    );
    expect(on).toContain('data-tool-approval="waiting"');
    expect(on).toContain('Waiting for approval');
  });

  it.each([
    ['success', { kind: 'text', content: 'ok' }],
    ['error', { kind: 'error', content: 'boom' }],
    ['interrupted', interruptedToolCallResult()],
  ] as const)(
    'lets a %s result win over a stale waiting signal',
    (status, result) => {
      const html = renderClean(
        <ToolCallCard
          toolName="Bash"
          label={getToolDisplayInfo('Bash', bash).label}
          input={bash}
          result={result}
        />,
        waitAll,
      );
      expect(html).toContain(`data-tool-status="${status}"`);
      expect(html).not.toContain('data-tool-approval');
      expect(html).not.toContain('Waiting');
    },
  );

  it('keeps a question on its own presentation', () => {
    const html = renderClean(
      <ToolCallCard toolName="AskUserQuestion" input="{}" />,
      waitAll,
    );
    expect(html).not.toContain('data-tool-approval');
  });

  it('lets a denied result win over a stale wait in both looks', () => {
    for (const look of ['classic', 'clean'] as const) {
      const html = renderToString(
        <ChatLookProvider value={look}>
          <ToolApprovalWaitProvider value={waitAll}>
            <ToolCallCard
              toolName="Bash"
              input={bash}
              awaitingApproval
              result={toolCallResultFrom({
                output: WRAPPED_SAFETY,
                isError: true,
              })}
            />
          </ToolApprovalWaitProvider>
        </ChatLookProvider>,
      );
      expect(html).toContain('data-tool-status="blocked"');
      expect(html).not.toContain('data-tool-approval');
    }
  });

  it('shows the note instead of the spinner in classic rows', () => {
    const html = renderToString(
      <ChatLookProvider value="classic">
        <ToolApprovalWaitProvider value={waitAll}>
          <ToolCallCard
            toolName="Bash"
            input={bash}
            pendingSpinner={<span data-testid="spinner" />}
          />
        </ToolApprovalWaitProvider>
      </ChatLookProvider>,
    );
    expect(html).toContain('Waiting for approval');
    expect(html).not.toContain('data-testid="spinner"');
  });
});
