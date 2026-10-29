/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceInputButton } from '../VoiceInputButton';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('VoiceInputButton', () => {
  it('uses the 14px app microphone glyph in the composer capsule', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <VoiceInputButton
        state="idle"
        error={null}
        onStart={jest.fn()}
        onStop={jest.fn()}
        capsule
      />,
    );

    const icon = host.querySelector<SVGElement>('[data-app-icon="true"]');
    const button = host.querySelector('button');
    expect(button?.getAttribute('data-composer-icon-button')).toBe('true');
    expect(button?.classList.contains('h-8')).toBe(true);
    expect(button?.classList.contains('w-8')).toBe(true);
    expect(button?.classList.contains('rounded-full')).toBe(true);
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('style')).toContain('width:14px');
    expect(icon?.getAttribute('style')).toContain('height:14px');
    expect(icon?.getAttribute('data-glyph')).toBe('mic');
  });

  it.each([
    // At rest the mic takes the primary ink, like the + beside it.
    [
      'idle',
      ['fg-primary', 'hover:bg-subtle'],
      ['fg-secondary', 'bg-destructive-subtle'],
    ],
    ['connecting', ['fg-secondary'], ['hover:bg-subtle', 'fg-destructive']],
    [
      'listening',
      [
        'bg-destructive-subtle',
        'fg-destructive',
        'hover:bg-destructive-subtle/80',
      ],
      ['fg-destructive/70'],
    ],
    [
      'error',
      [
        'fg-destructive/70',
        'hover:bg-destructive-subtle',
        'hover:fg-destructive',
      ],
      ['bg-destructive-subtle'],
    ],
  ] as const)(
    'maps the %s state onto the composer icon button tones',
    (state, expected, unexpected) => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        <VoiceInputButton
          state={state}
          error={state === 'error' ? 'Microphone unavailable' : null}
          onStart={jest.fn()}
          onStop={jest.fn()}
        />,
      );

      const classes = Array.from(host.querySelector('button')?.classList ?? []);
      expect(classes).toEqual(expect.arrayContaining([...expected]));
      for (const token of unexpected) {
        expect(classes).not.toContain(token);
      }
    },
  );

  it('explains itself with a rich tooltip instead of a native title (CAN-2799)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <VoiceInputButton
          state="idle"
          error={null}
          onStart={jest.fn()}
          onStop={jest.fn()}
        />,
      );
    });
    try {
      const button = host.querySelector<HTMLButtonElement>('button');
      expect(button?.getAttribute('aria-label')).toBe('Start voice dictation');
      expect(button?.hasAttribute('title')).toBe(false);
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        focusViaKeyboard(button);
      });
      // The tooltip names the action; the button keeps its full name.
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Dictate',
      );
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});

describe('VoiceInputButton shortcut hint', () => {
  it('shows its shortcut beside "Dictate" only while it can start', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderState = (state: 'idle' | 'listening'): void => {
      act(() => {
        root.render(
          <VoiceInputButton
            state={state}
            error={null}
            onStart={jest.fn()}
            onStop={jest.fn()}
            shortcut="⌃M"
          />,
        );
      });
    };
    try {
      renderState('idle');
      const button = host.querySelector<HTMLButtonElement>('button');
      act(() => {
        focusViaKeyboard(button);
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Dictate⌃M',
      );
      renderState('listening');
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Stop dictation',
      );
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
