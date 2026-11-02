/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExternalAgentSender,
  ToolMessageSender,
} from '@canopy/protocol/portal';
import { AgentSentMarker } from '../AgentSentMarker';
import { AgentSentMarker as RootExport } from '../../../index';
import { REPLAY_MASK_CLASS } from '../../../lib/replay-privacy';

function agentSent(
  overrides: Partial<ExternalAgentSender> = {},
): ExternalAgentSender {
  return {
    kind: 'external_agent',
    connectionId: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    clientName: 'Cursor',
    verified: true,
    userId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    ...overrides,
  };
}

describe('AgentSentMarker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(info: ToolMessageSender): HTMLElement {
    act(() => {
      root.render(<AgentSentMarker agentSent={info} />);
    });
    const marker = container.querySelector<HTMLElement>(
      '[data-testid="agent-sent-marker"]',
    );
    if (!marker) throw new Error('agent-sent-marker did not render');
    return marker;
  }

  it('is exported from the package entry point', () => {
    expect(RootExport).toBe(AgentSentMarker);
  });

  it('names a verified sending app without the unverified label', () => {
    const marker = render(agentSent());

    expect(marker.textContent).toBe('Sent by Cursor');
    expect(marker.dataset.verified).toBe('true');
    expect(
      marker.querySelector('[data-testid="agent-sent-marker-unverified"]'),
    ).toBeNull();
    // The icon is decorative; the readable text carries the meaning.
    expect(marker.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('adds the unverified label when the app is not verified', () => {
    const marker = render(
      agentSent({ clientName: 'Claude Code', verified: false }),
    );

    expect(marker.dataset.verified).toBe('false');
    expect(
      marker.querySelector('[data-testid="agent-sent-marker-name"]')
        ?.textContent,
    ).toBe('Sent by Claude Code');
    expect(
      marker.querySelector('[data-testid="agent-sent-marker-unverified"]')
        ?.textContent,
    ).toBe('Unverified app');
  });

  it('truncates a long name and keeps the full name in its title', () => {
    const longName = `Agent ${'x'.repeat(114)}`;
    expect(longName).toHaveLength(120);
    const marker = render(agentSent({ clientName: longName }));
    const name = marker.querySelector<HTMLElement>(
      '[data-testid="agent-sent-marker-name"]',
    );

    expect(name?.className).toContain('truncate');
    expect(name?.className).toContain('min-w-0');
    expect(name?.getAttribute('title')).toBe(longName);
    expect(name?.textContent).toBe(`Sent by ${longName}`);
  });

  it('names a managed delegate by its task, with no app verification', () => {
    const marker = render({
      kind: 'managed_delegate',
      delegationId: 'delegation-1',
      title: 'Independent error handling review',
    });

    expect(marker.textContent).toBe(
      'Sent by Independent error handling review',
    );
    expect(marker.dataset.sender).toBe('managed_delegate');
    expect(marker.dataset.verified).toBeUndefined();
    expect(
      marker.querySelector('[data-testid="agent-sent-marker-unverified"]'),
    ).toBeNull();
    // The subagent glyph, not the MCP app icon, and still decorative.
    const icon = marker.querySelector('svg');
    expect(icon?.getAttribute('data-glyph')).toBe('bot');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a delegate task out of the attributes replay records', () => {
    const task = 'Independent error handling review';
    const marker = render({
      kind: 'managed_delegate',
      delegationId: 'delegation-1',
      title: task,
    });

    // The task is user-authored: replay masks its text, and attributes are
    // recorded verbatim, so none may repeat it.
    expect(marker.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      task,
    );
    const elements: Element[] = [
      marker,
      ...Array.from(marker.querySelectorAll('*')),
    ];
    const attributeValues = elements.flatMap((element) =>
      Array.from(element.attributes, (attribute) => attribute.value),
    );
    expect(attributeValues.filter((value) => value.includes(task))).toEqual([]);
  });

  it('renders a markup-like name as plain text', () => {
    const hostile = '<img src=x onerror="alert(1)"><a href="https://x">y</a>';
    const marker = render(agentSent({ clientName: hostile }));

    expect(marker.querySelector('img')).toBeNull();
    expect(marker.querySelector('a')).toBeNull();
    expect(
      marker.querySelector('[data-testid="agent-sent-marker-name"]')
        ?.textContent,
    ).toBe(`Sent by ${hostile}`);
    expect(
      marker
        .querySelector('[data-testid="agent-sent-marker-name"]')
        ?.getAttribute('title'),
    ).toBe(hostile);
  });
});
