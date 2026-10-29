/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExternalAgentSender as AgentSentInfo } from '@canopy/protocol/portal';
import { AgentSentMarker } from '../AgentSentMarker';
import { AgentSentMarker as RootExport } from '../../../index';

function agentSent(overrides: Partial<AgentSentInfo> = {}): AgentSentInfo {
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

  function render(info: AgentSentInfo): HTMLElement {
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
