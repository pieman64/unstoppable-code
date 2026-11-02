/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ComposerSendButton,
  type ComposerSendButtonProps,
} from '../ComposerSendButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function classesOf(element: Element | null): string[] {
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

describe('ComposerSendButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: ComposerSendButtonProps): HTMLButtonElement {
    act(() => {
      root.render(<ComposerSendButton {...props} />);
    });
    const button = container.querySelector('button');
    if (!button) throw new Error('ComposerSendButton rendered no button');
    return button;
  }

  function click(button: HTMLButtonElement): void {
    act(() => {
      button.click();
    });
  }

  /** Hovers the control the way a pointer would and reads its tooltip. */
  function hoverTooltip(button: HTMLButtonElement): string | null {
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    return document.body.querySelector('[role="tooltip"]')?.textContent ?? null;
  }

  describe('send', () => {
    it('is named, typed as a button, and sends once when enabled', () => {
      const onSend = jest.fn();
      const button = render({
        kind: 'send',
        onSend,
        disabled: false,
        pending: false,
        dataTestId: 'home-send-button',
      });
      expect(button.getAttribute('aria-label')).toBe('Send message');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('data-testid')).toBe('home-send-button');
      expect(button.getAttribute('aria-busy')).toBe('false');
      click(button);
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('does not send while disabled', () => {
      const onSend = jest.fn();
      const button = render({
        kind: 'send',
        onSend,
        disabled: true,
        pending: false,
      });
      expect(button.disabled).toBe(true);
      click(button);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('waits for a pending model change even when not otherwise disabled', () => {
      const onSend = jest.fn();
      const button = render({
        kind: 'send',
        onSend,
        disabled: false,
        pending: true,
      });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(
        button.querySelector('[data-testid="chat-model-change-pending"]'),
      ).not.toBeNull();
      click(button);
      expect(onSend).not.toHaveBeenCalled();
      expect(hoverTooltip(button)).toBe('Updating model');
    });

    it('names the action and its key when ready, and the reason when blocked', () => {
      const ready = render({
        kind: 'send',
        onSend: jest.fn(),
        disabled: false,
        pending: false,
      });
      const readyTooltip = hoverTooltip(ready);
      expect(readyTooltip).toContain('Send');
      expect(readyTooltip).toContain('↵');

      act(() => root.unmount());
      root = createRoot(container);
      const blocked = render({
        kind: 'send',
        onSend: jest.fn(),
        disabled: true,
        pending: false,
        blockedReason: 'Sending paused: memory is running low',
      });
      expect(hoverTooltip(blocked)).toBe(
        'Sending paused: memory is running low',
      );
    });

    it.each<ComposerSendButtonProps>([
      { kind: 'send', onSend: jest.fn(), disabled: false, pending: false },
      { kind: 'stop', onStop: jest.fn() },
      { kind: 'terminal', onRun: jest.fn(), disabled: false },
    ])('$kind does not submit an enclosing form', (props) => {
      const onSubmit = jest.fn((event: SubmitEvent) => event.preventDefault());
      const form = document.createElement('form');
      form.addEventListener('submit', onSubmit);
      container.append(form);
      const formRoot = createRoot(form);
      act(() => {
        formRoot.render(<ComposerSendButton {...props} />);
      });
      const button = form.querySelector('button');
      act(() => button?.click());
      const callback =
        props.kind === 'send'
          ? props.onSend
          : props.kind === 'stop'
            ? props.onStop
            : props.onRun;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
      act(() => formRoot.unmount());
    });
  });

  describe('stop', () => {
    it('stops once with no default test id', () => {
      const onStop = jest.fn();
      const button = render({ kind: 'stop', onStop });
      expect(button.getAttribute('aria-label')).toBe('Stop generation');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.hasAttribute('data-testid')).toBe(false);
      expect(button.getAttribute('aria-busy')).toBe('false');
      expect(hoverTooltip(button)).toBe('Stop generation');
      click(button);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('carries an explicit test id and the shortcut state', () => {
      const button = render({
        kind: 'stop',
        onStop: jest.fn(),
        shortcutReady: true,
        dataTestId: 'chat-stop-generation',
      });
      expect(button.getAttribute('data-testid')).toBe('chat-stop-generation');
      expect(button.getAttribute('data-cancel-shortcut-ready')).toBe('true');
      expect(button.hasAttribute('data-cancel-armed')).toBe(false);
    });

    it('widens into the Esc capsule when armed', () => {
      const button = render({ kind: 'stop', onStop: jest.fn(), armed: true });
      expect(button.getAttribute('aria-label')).toBe('Press Esc again to stop');
      expect(button.getAttribute('data-cancel-armed')).toBe('true');
      expect(button.textContent).toBe('Esc');
      expect(hoverTooltip(button)).toBe('Press Esc again to stop');
      expect(classesOf(button)).toEqual(
        expect.arrayContaining(['h-8', 'gap-1.5', 'px-3']),
      );
      expect(classesOf(button)).not.toContain('w-8');
    });

    it('lets a pending model change outrank the armed Esc', () => {
      const onStop = jest.fn();
      const button = render({
        kind: 'stop',
        onStop,
        armed: true,
        pending: true,
      });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('Stop generation');
      expect(button.textContent).not.toContain('Esc');
      expect(
        button.querySelector('[data-testid="chat-model-change-pending"]'),
      ).not.toBeNull();
      expect(hoverTooltip(button)).toBe('Updating model');
      click(button);
      expect(onStop).not.toHaveBeenCalled();
    });

    it('disables without a spinner when the host cannot stop', () => {
      const onStop = jest.fn();
      const button = render({ kind: 'stop', onStop, disabled: true });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('false');
      expect(
        button.querySelector('[data-testid="chat-model-change-pending"]'),
      ).toBeNull();
      click(button);
      expect(onStop).not.toHaveBeenCalled();
    });

    it('clears the busy state when the model change lands', () => {
      const props = { kind: 'stop', onStop: jest.fn() } as const;
      render({ ...props, pending: true });
      const button = render({ ...props, pending: false });
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-busy')).toBe('false');
      expect(
        button.querySelector('[data-testid="chat-model-change-pending"]'),
      ).toBeNull();
    });
  });

  describe('terminal', () => {
    it('runs once when enabled and not while disabled', () => {
      const onRun = jest.fn();
      const enabled = render({ kind: 'terminal', onRun, disabled: false });
      expect(enabled.getAttribute('aria-label')).toBe('Run terminal command');
      expect(enabled.getAttribute('type')).toBe('button');
      expect(hoverTooltip(enabled)).toBe('Run terminal command');
      click(enabled);
      expect(onRun).toHaveBeenCalledTimes(1);

      const disabled = render({ kind: 'terminal', onRun, disabled: true });
      click(disabled);
      expect(onRun).toHaveBeenCalledTimes(1);
    });

    it('stays clickable after a failed command, and failure never overrides disablement', () => {
      const onRun = jest.fn();
      const failed = render({
        kind: 'terminal',
        onRun,
        disabled: false,
        failed: true,
        dataTestId: 'composer-run',
      });
      expect(failed.getAttribute('data-testid')).toBe('composer-run');
      expect(classesOf(failed)).toContain('bg-destructive');
      expect(classesOf(failed)).not.toContain('bg-warning');
      click(failed);
      expect(onRun).toHaveBeenCalledTimes(1);

      const failedDisabled = render({
        kind: 'terminal',
        onRun,
        disabled: true,
        failed: true,
      });
      expect(failedDisabled.disabled).toBe(true);
      expect(classesOf(failedDisabled)).toContain('disabled:bg-muted');
      click(failedDisabled);
      expect(onRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('tap target', () => {
    const kinds: ComposerSendButtonProps[] = [
      { kind: 'send', onSend: jest.fn(), disabled: false, pending: false },
      { kind: 'stop', onStop: jest.fn() },
      { kind: 'terminal', onRun: jest.fn(), disabled: false },
    ];

    it.each(kinds)('$kind is a 32px control by default', (props) => {
      const classes = classesOf(render(props));
      expect(classes).toEqual(expect.arrayContaining(['h-8', 'w-8']));
      expect(classes).not.toContain('h-11');
    });

    it.each(kinds)('$kind keeps a 44px touch target below lg', (props) => {
      const classes = classesOf(render({ ...props, tapTarget: 'touch' }));
      expect(classes).toEqual(
        expect.arrayContaining(['h-11', 'w-11', 'lg:h-8', 'lg:w-8']),
      );
      expect(classes).not.toContain('h-8');
      expect(classes).not.toContain('w-8');
    });

    it('keeps the armed capsule unfixed in width on touch', () => {
      const classes = classesOf(
        render({
          kind: 'stop',
          onStop: jest.fn(),
          armed: true,
          tapTarget: 'touch',
        }),
      );
      expect(classes).toEqual(
        expect.arrayContaining(['h-11', 'gap-1.5', 'px-3', 'lg:h-8']),
      );
      expect(classes.some((name) => /(^|:)w-/.test(name))).toBe(false);
    });
  });

  it('renders no native title on any kind', () => {
    const kinds: ComposerSendButtonProps[] = [
      { kind: 'send', onSend: jest.fn(), disabled: true, pending: false },
      { kind: 'stop', onStop: jest.fn(), armed: true },
      { kind: 'terminal', onRun: jest.fn(), disabled: false },
    ];
    for (const props of kinds) {
      render(props);
      expect(container.querySelector('[title]')).toBeNull();
    }
  });

  it('uses the accent stop with a filled glyph', () => {
    const button = render({ kind: 'stop', onStop: jest.fn() });
    expect(classesOf(button)).toContain('bg-accent');
    expect(classesOf(button)).not.toContain('bg-destructive-subtle');
    expect(button.querySelector('svg')).not.toBeNull();
  });
});
