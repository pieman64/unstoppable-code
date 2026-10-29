/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import { AgentBlock } from '../AgentBlock';
import { WorkflowBlock } from '../WorkflowBlock';
import type { ToolResult } from '../types';

jest.mock('@/hooks/useWorkflowRun', () => ({
  useWorkflowRun: (): { run: null; loading: false } => ({
    run: null,
    loading: false,
  }),
}));
jest.mock('../../activity/WorkflowRunView', () => ({
  WorkflowRunView: (): null => null,
}));
jest.mock('../../activity/WorkflowIcon', () => ({
  WorkflowIcon: (): JSX.Element => <span />,
}));
jest.mock('../../activity/RunOutputControls', () => ({
  ChevronIcon: (): JSX.Element => <span />,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const reference: PersistedToolOutputReference = {
  version: 1,
  artifactId: `sha256-v1-${'b'.repeat(64)}`,
  sha256: 'b'.repeat(64),
  byteLength: 100000,
  encoding: 'utf-8',
  mediaType: 'text/plain',
};
const deferredResult: ToolResult = {
  output: 'bounded agent output',
  isError: false,
  fullOutputRef: reference,
  messageId: 'message-1',
  toolUseId: 'tool-1',
};

/**
 * These cards already show the bounded output in their own result section, so
 * the deferred viewer beneath them contributes only the "View full output"
 * control. Its preview `<pre>` must not render as an empty padded box.
 */
describe('deferred full-output viewer beneath agent and workflow cards', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function expectHiddenEmptyPreview(): void {
    const host = container.querySelector(
      '[data-testid="chat-deferred-output-host"]',
    );
    if (!(host instanceof HTMLElement))
      throw new Error('Missing deferred output host');
    // The card owns the visible output, so the viewer renders no preview
    // block at all until the full output is opened.
    expect(
      host.querySelector('[data-testid="chat-tool-output-text"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="chat-tool-output-open"]'),
    ).not.toBeNull();
  }

  it('hides the empty preview beneath an agent card', () => {
    act(() => {
      root.render(
        <AgentBlock
          subagentType="general-purpose"
          description="Investigate"
          prompt="Look into it"
          runInBackground={false}
          result={deferredResult}
          subBlocks={[]}
          renderSubBlock={(): null => null}
        />,
      );
    });
    expectHiddenEmptyPreview();
  });

  it('hides the empty preview beneath a workflow card', () => {
    act(() => {
      root.render(
        <WorkflowBlock
          workflowName="review"
          summary="Review the change"
          result={deferredResult}
        />,
      );
    });
    expectHiddenEmptyPreview();
  });
});
