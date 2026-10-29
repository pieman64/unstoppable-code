/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CapabilityPruneNotice,
  capabilityPruneNoticeMessage,
} from '../CapabilityPruneNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('capability prune notice copy (REG-3042)', () => {
  it.each([
    [
      [{ kind: 'mcpServer' as const, displayName: 'Dropbox' }],
      "Dropbox was removed from this chat because it's no longer available.",
    ],
    [
      [{ kind: 'skill' as const }],
      "A skill was removed from this chat because it's no longer available.",
    ],
    [
      [{ kind: 'mcpServer' as const }],
      "An MCP server was removed from this chat because it's no longer available.",
    ],
    [
      [
        { kind: 'mcpServer' as const, displayName: 'Dropbox' },
        { kind: 'plugin' as const, displayName: 'Docs' },
      ],
      "Dropbox and Docs were removed from this chat because they're no longer available.",
    ],
    [
      [
        { kind: 'mcpServer' as const, displayName: 'Dropbox' },
        { kind: 'skill' as const },
      ],
      "Dropbox and 1 more were removed from this chat because they're no longer available.",
    ],
    [
      [
        { kind: 'mcpServer' as const, displayName: 'Dropbox' },
        { kind: 'plugin' as const, displayName: 'Docs' },
        { kind: 'skill' as const, displayName: 'Review' },
      ],
      "Dropbox, Docs, and 1 more were removed from this chat because they're no longer available.",
    ],
    [
      [{ kind: 'skill' as const }, { kind: 'plugin' as const }],
      "2 plugins, skills, or MCP servers were removed from this chat because they're no longer available.",
    ],
  ])('%j', (pruned, message) => {
    expect(capabilityPruneNoticeMessage(pruned)).toBe(message);
  });
});

describe('CapabilityPruneNotice', () => {
  it('names what was removed, dismisses, and renders nothing for an empty prune', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDismiss = jest.fn();
    act(() => {
      root.render(
        <CapabilityPruneNotice
          pruned={[{ kind: 'mcpServer', displayName: 'Dropbox' }]}
          onDismiss={onDismiss}
        />,
      );
    });
    const notice = container.querySelector(
      '[data-testid="chat-capability-prune-notice"]',
    );
    expect(notice?.textContent).toContain(
      "Dropbox was removed from this chat because it's no longer available.",
    );
    const dismiss = notice?.querySelector('button');
    if (!(dismiss instanceof HTMLButtonElement))
      throw new Error('Dismiss not found');
    act(() => dismiss.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(<CapabilityPruneNotice pruned={[]} onDismiss={onDismiss} />);
    });
    expect(container.innerHTML).toBe('');
    act(() => root.unmount());
    container.remove();
  });
});
