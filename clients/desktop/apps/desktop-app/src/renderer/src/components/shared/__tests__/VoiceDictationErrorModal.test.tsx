/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VoiceDictationErrorModal } from '../VoiceDictationErrorModal';
import type { VoiceErrorGuidance } from '@/lib/voice/voice-error';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const DENIED_GUIDANCE: VoiceErrorGuidance = {
  kind: 'microphone-permission-denied',
  title: 'Allow microphone access for Canopy',
  steps: ['Open System Settings → Privacy & Security → Microphone.'],
  settingsUrl:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  settingsLabel: 'Open Microphone Privacy',
};

function render(
  guidance: VoiceErrorGuidance | null,
  onDismiss: () => void,
): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(VoiceDictationErrorModal, { guidance, onDismiss }),
    );
  });
  return {
    container,
    unmount: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe('VoiceDictationErrorModal', () => {
  const openSettings = jest.fn<Promise<void>, [{ url: string }]>(() =>
    Promise.resolve(),
  );

  beforeEach(() => {
    openSettings.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { voice: { openSettings } },
    });
  });

  it('renders nothing when there is no failure to explain', () => {
    const view = render(null, jest.fn());
    try {
      expect(
        document.querySelector('[data-testid="voice-error-modal"]'),
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it('deep-links to the System Settings pane for the failure', () => {
    const view = render(DENIED_GUIDANCE, jest.fn());
    try {
      const button = Array.from(document.querySelectorAll('button')).find(
        (el) => el.textContent === 'Open Microphone Privacy',
      );
      expect(button).toBeDefined();

      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(openSettings).toHaveBeenCalledWith({
        url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      });
    } finally {
      view.unmount();
    }
  });

  it('closes itself after handing the user off to System Settings', () => {
    // The modal traps focus behind a backdrop, so leaving it open would make
    // the user dismiss it before they can reach the mic button the last step
    // tells them to click.
    const onDismiss = jest.fn();
    const view = render(DENIED_GUIDANCE, onDismiss);
    try {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="voice-error-modal-settings"]',
      );

      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it('dismisses only the current failure', () => {
    const onDismiss = jest.fn();
    const view = render(DENIED_GUIDANCE, onDismiss);
    try {
      const close = document.querySelector<HTMLButtonElement>(
        '[data-testid="voice-error-modal-close"]',
      );
      act(() => {
        close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
});
