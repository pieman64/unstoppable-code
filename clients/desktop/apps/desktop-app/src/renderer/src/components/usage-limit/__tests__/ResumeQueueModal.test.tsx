/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { ResumeQueueModal } from '../ResumeQueueModal';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const reporter = jest.mocked(useCurrentUiStateReporter);

describe('ResumeQueueModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    reporter.mockClear();
    const snapshot = {
      version: 1 as const,
      revision: 1,
      paused: false,
      entries: [
        {
          id: 'entry-1',
          target: {
            kind: 'chat' as const,
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
          },
          interruptionId: '1',
          title: 'Chat',
          workspaceName: 'Workspace',
          createdAt: 1,
          status: 'waiting' as const,
        },
      ],
    };
    useResumeQueueStore.setState({
      snapshot,
      isOpen: true,
      connectionError: null,
    });
    useUsageLimitResumePromptStore.setState({ isOpen: false });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onResumeQueueChanged: jest.fn(() => jest.fn()),
        getResumeQueue: jest.fn().mockResolvedValue(snapshot),
        controlResumeQueue: jest.fn().mockResolvedValue(snapshot),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows providers, pipeline identity, and ten-second pacing', async () => {
    const snapshot = useResumeQueueStore.getState().snapshot;
    if (!snapshot) throw new Error('Expected queue snapshot');
    Object.assign(snapshot.entries[0], { providers: ['codex'] });
    snapshot.entries.push({
      ...snapshot.entries[0],
      id: 'pipeline',
      title: 'Build',
      target: {
        kind: 'pipeline',
        executionId: 'execution',
        statusReasonIds: ['reason'],
      },
      ...{ providers: ['claude', 'codex'] },
    });
    await act(async () => {
      root.render(createElement(ResumeQueueModal));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="resume-queue-entry-entry-1"]')
        ?.textContent,
    ).toContain('Codex');
    expect(
      document.querySelector('[data-testid="resume-queue-entry-pipeline"]')
        ?.textContent,
    ).toContain('Pipeline · Claude, Codex');
    expect(document.body.textContent).toContain('10-second delay');
    expect(document.body.textContent).not.toContain(
      'wait while the app is busy',
    );
  });

  it('uses semantic-token hairlines and reports sanitized queue state', async () => {
    await act(async () => {
      root.render(createElement(ResumeQueueModal));
      await Promise.resolve();
    });

    const list = document.querySelector('ol[aria-label="Sessions to resume"]');
    expect(list?.className).toContain('before:bg-[var(--line-base)]');
    expect(list?.className).toContain('after:bg-[var(--line-base)]');
    expect(list?.className).not.toContain('border-border');
    expect(reporter.mock.calls[0]?.[0]).toBe('usage.resumeQueueModal');
    expect(reporter.mock.calls[0]?.[1]).toEqual({
      open: true,
      paused: false,
      pending: false,
      processed: 0,
      total: 1,
      active: true,
      errorVisible: false,
    });
  });
});
