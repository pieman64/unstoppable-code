/**
 * @jest-environment jsdom
 */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { ChatInterfaceModeToggle } from '../ChatInterfaceModeToggle';

describe('ChatInterfaceModeToggle', () => {
  beforeEach(() => {
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  it('hides when Claude TUI chats are disabled', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key] =
      false;
    useFeatureFlagsStore.setState({ snapshot });

    const rendered = await renderToggle();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="chat-interface-mode-toggle"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('renders for Claude chats when Claude TUI chats are enabled', async () => {
    const rendered = await renderToggle();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="chat-interface-mode-toggle"]',
        ),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('moves only the inset selector while option state and hover stay immediate', async () => {
    const rendered = await renderToggle();

    try {
      const toggle = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle"]',
      );
      const canopy = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-canopy"]',
      );
      const auto = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-auto"]',
      );
      const selector = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-selector"]',
      );

      expect(toggle?.className).toContain('h-8');
      expect(toggle?.className).toContain('rounded-full');
      expect(toggle?.className).toContain('bg-muted');
      expect(toggle?.className).toContain('p-0.5');

      expect(canopy?.className).toContain('h-7');
      expect(canopy?.className).toContain('w-7');
      expect(canopy?.className).toContain('rounded-full');
      expect(canopy?.className).toContain('fg-primary');
      expect(canopy?.className).not.toContain('transition-');

      expect(auto?.className).not.toContain('transition-');
      expect(selector?.className).toContain('bg-quaternary');
      expect(selector?.className).toContain('shadow-sm');
      expect(selector?.className).toContain('transition-[transform]');
      expect(selector?.className).toContain('duration-200');
      expect(selector?.className).toContain('ease-out');
      expect(selector?.className).toContain('motion-reduce:transition-none');
      expect(selector?.style.transform).toBe('translateX(0px)');
    } finally {
      rendered.cleanup();
    }
  });

  it('explains each option with a rich tooltip instead of a native title (CAN-2799)', async () => {
    const rendered = await renderToggle();

    try {
      const buttons = Array.from(
        rendered.container.querySelectorAll<HTMLButtonElement>('button'),
      );
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(button.hasAttribute('title')).toBe(false);
      }
      const claudeCode = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-claude-code"]',
      );
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        focusViaKeyboard(claudeCode);
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Claude Code',
      );
      // The sliding selector still assumes three 28px slots.
      const selector = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-selector"]',
      );
      expect(selector?.style.transform).toBe('translateX(0px)');
    } finally {
      rendered.cleanup();
    }
  });

  it('restores receding chrome when floated over terminal output', async () => {
    const rendered = await renderToggle(true);

    try {
      const toggle = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle"]',
      );
      expect(toggle?.className).toContain('bg-card/95');
      expect(toggle?.className).toContain('opacity-60');
      expect(toggle?.className).toContain('backdrop-blur');
      expect(toggle?.className).toContain('hover:opacity-100');
      expect(toggle?.className).not.toContain('bg-muted');
    } finally {
      rendered.cleanup();
    }
  });

  it('uses three 14px app glyphs', async () => {
    const rendered = await renderToggle();

    try {
      const icons: NodeListOf<Element> = rendered.container.querySelectorAll(
        '[data-app-icon="true"]',
      );
      expect(icons).toHaveLength(3);
      for (const icon of Array.from(icons)) {
        expect(icon.getAttribute('style')).toContain('width: 14px');
        expect(icon.getAttribute('style')).toContain('height: 14px');
      }
    } finally {
      rendered.cleanup();
    }
  });

  it('uses the letter-A circle glyph for the middle mode', async () => {
    const rendered = await renderToggle();

    try {
      const auto = rendered.container.querySelector<HTMLElement>(
        '[data-testid="chat-interface-mode-toggle-auto"]',
      );

      expect(auto?.querySelector('svg')?.getAttribute('data-glyph')).toBe(
        'circle-gauge',
      );
    } finally {
      rendered.cleanup();
    }
  });
});

async function renderToggle(floating = false): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <ChatInterfaceModeToggle
        mode="canopy"
        onChange={jest.fn()}
        providerIsClaude
        canopyNativeBusy={false}
        floating={floating}
      />,
    );
    await Promise.resolve();
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}
