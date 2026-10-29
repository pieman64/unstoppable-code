/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { SubagentNode } from '@canopy/agent-transcript';
import {
  useSubagentTranscriptPages,
  type SubagentTranscriptPagesQuery,
} from '../useSubagentTranscriptPages';
import type { SubagentHostScope } from '../subagent-scope';
import type { ChatMessage } from '@/stores/chatStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const scope: SubagentHostScope = {
  projectId: 'pages-project',
  worktreeId: 'pages-worktree',
};

const selectedNode: SubagentNode = {
  id: 'delegate-1',
  kind: 'managed',
  parentId: null,
  depth: 1,
  title: 'Delegate',
  status: 'running',
  childIds: [],
  liveDescendantCount: 0,
  approvalPending: false,
  runs: [{ runGeneration: 1, agentBlockId: 'run-1' }],
};

interface PagesProbeProps {
  readonly onResult: (result: SubagentTranscriptPagesQuery) => void;
  readonly node?: SubagentNode;
  readonly rootMessages?: readonly ChatMessage[];
}

function PagesProbe({
  onResult,
  node = selectedNode,
  rootMessages = [],
}: PagesProbeProps): JSX.Element {
  const result = useSubagentTranscriptPages(
    scope,
    'root-chat',
    node,
    rootMessages,
    { enabled: true },
  );
  onResult(result);
  const run = result.runs.get(1);
  return (
    <div data-testid="paged-transcript">
      {run?.messages
        .map((message) => {
          const block = message.blocks[0];
          return block?.type === 'text' ? block.text : '';
        })
        .join('|') ?? ''}
      {result.hasOlder ? ':older' : ':done'}
      {result.loadingOlder ? ':loading' : ''}
    </div>
  );
}

describe('useSubagentTranscriptPages', () => {
  it('loads the latest page, offers older messages, and requests before the first sequence', async () => {
    const transcript = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        task: {
          description: 'Delegate',
          prompt: 'Complete the task.',
          executionMode: 'background',
        },
        snapshot: {},
        runGeneration: 1,
        items: [
          {
            id: 'later',
            sequence: 5,
            occurredAt: 5,
            type: 'text',
            text: 'Later output.',
          },
        ],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        task: {
          description: 'Delegate',
          prompt: 'Complete the task.',
          executionMode: 'background',
        },
        snapshot: {},
        runGeneration: 1,
        items: [
          {
            id: 'first',
            sequence: 1,
            occurredAt: 1,
            type: 'text',
            text: 'First output.',
          },
        ],
        hasMore: false,
      });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcriptPage: transcript } },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const captured: { current?: SubagentTranscriptPagesQuery } = {};
    const onResult = (result: SubagentTranscriptPagesQuery): void => {
      captured.current = result;
    };

    await act(async () => {
      root.render(<PagesProbe onResult={onResult} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transcript).toHaveBeenCalledWith({
      projectId: 'pages-project',
      worktreeId: 'pages-worktree',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
      runGeneration: 1,
      limit: 100,
    });
    expect(container.textContent).toContain('Later output.:older');
    const pageQuery = captured.current;
    if (!pageQuery) throw new Error('transcript page result was not captured');
    expect(pageQuery.runs.get(1)?.task.prompt).toBe('Complete the task.');

    await act(async () => {
      pageQuery.onLoadOlder();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transcript).toHaveBeenLastCalledWith({
      projectId: 'pages-project',
      worktreeId: 'pages-worktree',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
      runGeneration: 1,
      beforeSequence: 5,
      limit: 100,
    });
    expect(container.textContent).toContain('First output.|Later output.:done');
    act((): void => root.unmount());
  });

  function page(
    runGeneration: number,
    texts: readonly string[],
    prompt = `Prompt ${runGeneration}`,
  ): Record<string, unknown> {
    return {
      ok: true,
      task: { description: 'Delegate', prompt, executionMode: 'background' },
      snapshot: {},
      runGeneration,
      revision: texts.length,
      items: texts.map((text, index) => ({
        id: `run-${runGeneration}-item-${index}`,
        sequence: index + 1,
        occurredAt: index + 1,
        type: 'text',
        text,
      })),
      hasMore: false,
    };
  }

  function texts(
    result: SubagentTranscriptPagesQuery | undefined,
    runGeneration: number,
  ): string[] {
    return (
      result?.runs.get(runGeneration)?.messages.map((message) => {
        const block = message.blocks[0];
        return block?.type === 'text' ? block.text : '';
      }) ?? []
    );
  }

  it('keeps earlier runs when a follow-up starts another run', async () => {
    const transcript = jest.fn(
      (request: { runGeneration: number }): Promise<Record<string, unknown>> =>
        Promise.resolve(
          page(request.runGeneration, [`Run ${request.runGeneration} output.`]),
        ),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcriptPage: transcript } },
    });
    const settled: SubagentNode = {
      ...selectedNode,
      status: 'completed',
      runs: [{ runGeneration: 1 }, { runGeneration: 2 }],
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    const captured: { current?: SubagentTranscriptPagesQuery } = {};
    const onResult = (result: SubagentTranscriptPagesQuery): void => {
      captured.current = result;
    };
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };

    await act(async () => {
      root.render(<PagesProbe onResult={onResult} node={settled} />);
      await settle();
    });
    expect(texts(captured.current, 1)).toEqual(['Run 1 output.']);
    expect(texts(captured.current, 2)).toEqual(['Run 2 output.']);
    expect(captured.current?.runs.get(1)?.task.prompt).toBe('Prompt 1');

    await act(async () => {
      root.render(
        <PagesProbe
          onResult={onResult}
          node={{
            ...settled,
            status: 'running',
            runs: [...settled.runs, { runGeneration: 3 }],
          }}
        />,
      );
      await settle();
    });
    expect(texts(captured.current, 1)).toEqual(['Run 1 output.']);
    expect(texts(captured.current, 2)).toEqual(['Run 2 output.']);
    expect(texts(captured.current, 3)).toEqual(['Run 3 output.']);
    expect(
      transcript.mock.calls.filter(([request]) => request.runGeneration === 1),
    ).toHaveLength(1);
    act((): void => root.unmount());
  });

  it('refreshes a running run and shows its page instead of the root chat copy', async () => {
    jest.useFakeTimers();
    try {
      let outputs = ['Started.'];
      const transcript = jest.fn(
        (request: {
          sinceRevision?: number;
        }): Promise<Record<string, unknown>> =>
          Promise.resolve(
            request.sinceRevision !== undefined &&
              request.sinceRevision >= outputs.length
              ? { ...page(1, []), revision: outputs.length, unchanged: true }
              : page(1, outputs),
          ),
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { managedDelegation: { transcriptPage: transcript } },
      });
      const rootRow: ChatMessage = {
        id: 'run-1:turn0:hash',
        role: 'assistant',
        timestamp: 1,
        parentBlockId: 'run-1',
        delegationSequence: 1,
        blocks: [{ type: 'text', text: 'Started.' }],
      };
      const container = document.createElement('div');
      const root = createRoot(container);
      const captured: { current?: SubagentTranscriptPagesQuery } = {};
      const onResult = (result: SubagentTranscriptPagesQuery): void => {
        captured.current = result;
      };
      const settle = async (): Promise<void> => {
        for (let index = 0; index < 4; index += 1) await Promise.resolve();
      };

      await act(async () => {
        root.render(
          <PagesProbe onResult={onResult} rootMessages={[rootRow]} />,
        );
        await settle();
      });
      expect(texts(captured.current, 1)).toEqual(['Started.']);
      expect(captured.current?.runs.get(1)?.replacesRootRows).toBe(true);

      // A re-read that finds no change keeps what is shown.
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await settle();
      });
      expect(transcript).toHaveBeenLastCalledWith(
        expect.objectContaining({ runGeneration: 1, sinceRevision: 1 }),
      );
      expect(texts(captured.current, 1)).toEqual(['Started.']);

      outputs = ['Started.', 'Read the file.', 'Done.'];
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await settle();
      });
      expect(texts(captured.current, 1)).toEqual([
        'Started.',
        'Read the file.',
        'Done.',
      ]);

      const calls = transcript.mock.calls.length;
      await act(async () => {
        root.render(
          <PagesProbe
            onResult={onResult}
            rootMessages={[rootRow]}
            node={{ ...selectedNode, status: 'completed' }}
          />,
        );
        await settle();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await settle();
      });
      // One final read when the run settles, then no more polling.
      expect(transcript.mock.calls.length).toBe(calls + 1);
      act((): void => root.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a message moved to a continuation run from the earlier run', async () => {
    let firstRunTexts = ['Working.', 'Make that three.'];
    const transcript = jest.fn(
      (request: { runGeneration: number }): Promise<Record<string, unknown>> =>
        Promise.resolve(
          request.runGeneration === 1
            ? page(1, firstRunTexts)
            : page(2, ['Make that three.', 'Three answers.']),
        ),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcriptPage: transcript } },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const captured: { current?: SubagentTranscriptPagesQuery } = {};
    const onResult = (result: SubagentTranscriptPagesQuery): void => {
      captured.current = result;
    };
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    };

    await act(async () => {
      root.render(<PagesProbe onResult={onResult} />);
      await settle();
    });
    expect(texts(captured.current, 1)).toEqual([
      'Working.',
      'Make that three.',
    ]);

    // The steer started run 2, which the broker moved the message into.
    firstRunTexts = ['Working.'];
    await act(async () => {
      root.render(
        <PagesProbe
          onResult={onResult}
          node={{
            ...selectedNode,
            runs: [...selectedNode.runs, { runGeneration: 2 }],
          }}
        />,
      );
      await settle();
    });
    expect(texts(captured.current, 1)).toEqual(['Working.']);
    expect(texts(captured.current, 2)).toEqual([
      'Make that three.',
      'Three answers.',
    ]);
    act((): void => root.unmount());
  });
});
