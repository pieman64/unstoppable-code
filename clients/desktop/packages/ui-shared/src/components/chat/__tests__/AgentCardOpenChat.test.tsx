/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { AgentBlockCard } from '../AgentBlockCard';
import { DelegatedAgentCard } from '../DelegatedAgentCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: AgentDelegationSnapshot = {
  delegationId: 'child',
  status: 'completed',
  outputTruncated: false,
};

function mount(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => {
    root.render(node);
  });
  return { container, root };
}

function expand(container: HTMLDivElement): void {
  const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded]');
  if (!toggle) throw new Error('Agent card expand control was not rendered.');
  act((): void => toggle.click());
}

function openAction(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="agent-card-open-chat"]',
  );
}

describe('agent-card Open chat action', () => {
  it('leads an expanded native agent card and invokes its callback', () => {
    const onOpenChat = jest.fn();
    const { container, root } = mount(
      <AgentBlockCard
        subagentType="Explore"
        metadata={<div data-testid="agent-metadata">Metadata</div>}
        onOpenChat={onOpenChat}
      />,
    );

    expect(openAction(container)).toBeNull();
    expand(container);

    const action = openAction(container);
    const metadata = container.querySelector('[data-testid="agent-metadata"]');
    if (!action || !metadata)
      throw new Error('Expanded details were not rendered.');
    const details = metadata.parentElement;
    expect(
      details?.firstElementChild?.querySelector(
        '[data-testid="agent-card-open-chat"]',
      ),
    ).not.toBeNull();
    expect(details?.children[1]).toBe(metadata);
    act((): void => action.click());
    expect(onOpenChat).toHaveBeenCalledTimes(1);

    act((): void => root.unmount());
  });

  it('does not render on a native agent card when no callback is supplied', () => {
    const { container, root } = mount(
      <AgentBlockCard subagentType="Explore" />,
    );
    expand(container);
    expect(openAction(container)).toBeNull();
    act((): void => root.unmount());
  });

  it('leads delegated-card metadata and invokes its callback', () => {
    const onOpenChat = jest.fn();
    const { container, root } = mount(
      <DelegatedAgentCard
        snapshot={snapshot}
        parentHarnessId="codex"
        description="Review source"
        prompt="Read source"
        executionMode="background"
        onOpenChat={onOpenChat}
      />,
    );

    expect(openAction(container)).toBeNull();
    expand(container);

    const action = openAction(container);
    const metadata = container.querySelector(
      '[data-testid="delegated-agent-metadata"]',
    );
    if (!action || !metadata)
      throw new Error('Expanded details were not rendered.');
    expect(
      metadata.firstElementChild?.querySelector(
        '[data-testid="agent-card-open-chat"]',
      ),
    ).not.toBeNull();
    act((): void => action.click());
    expect(onOpenChat).toHaveBeenCalledTimes(1);

    act((): void => root.unmount());
  });

  it('does not render on a delegated card when no callback is supplied', () => {
    const { container, root } = mount(
      <DelegatedAgentCard
        snapshot={snapshot}
        parentHarnessId="codex"
        description="Review source"
        prompt="Read source"
        executionMode="background"
      />,
    );
    expand(container);
    expect(openAction(container)).toBeNull();
    act((): void => root.unmount());
  });
});
