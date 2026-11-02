/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CodexAccountModelNotice,
  type CodexAccountModelNoticeProps,
} from '../CodexAccountModelNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WITH_FALLBACK: CodexAccountModelNoticeProps['failure'] = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
  fallbackModel: 'gpt-6-luna',
  fallbackModelLabel: 'Luna 6.0',
};

const WITHOUT_FALLBACK: CodexAccountModelNoticeProps['failure'] = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
};

describe('CodexAccountModelNotice', () => {
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

  function render(props: CodexAccountModelNoticeProps): void {
    act(() => {
      root.render(<CodexAccountModelNotice {...props} />);
    });
  }

  function button(
    testId = 'chat-codex-account-model-notice',
  ): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}-use-fallback"]`,
    );
  }

  it('offers the fallback model when one is known', () => {
    const onUseFallback = jest.fn();
    render({ failure: WITH_FALLBACK, onUseFallback });

    const notice = container.querySelector(
      '[data-testid="chat-codex-account-model-notice"]',
    );
    expect(notice?.textContent).toContain(
      "Your ChatGPT account can't use 6.1 Sol.",
    );
    expect(notice?.textContent).not.toContain('Choose another model.');
    expect(button()?.textContent).toBe('Use Luna 6.0');

    act(() => {
      button()?.click();
    });
    expect(onUseFallback).toHaveBeenCalledTimes(1);
  });

  it('asks for another model when no fallback is known', () => {
    render({ failure: WITHOUT_FALLBACK, onUseFallback: jest.fn() });

    expect(container.textContent).toContain(
      "Your ChatGPT account can't use 6.1 Sol. Choose another model.",
    );
    expect(button()).toBeNull();
  });

  it('is read-only without a handler', () => {
    render({ failure: WITH_FALLBACK });

    expect(container.textContent).toContain(
      "Your ChatGPT account can't use 6.1 Sol.",
    );
    expect(button()).toBeNull();
  });

  it('disables the action and marks it busy', () => {
    const onUseFallback = jest.fn();
    render({ failure: WITH_FALLBACK, onUseFallback, disabled: true });
    expect(button()?.disabled).toBe(true);
    act(() => {
      button()?.click();
    });
    expect(onUseFallback).not.toHaveBeenCalled();

    render({ failure: WITH_FALLBACK, onUseFallback, busy: true });
    expect(button()?.getAttribute('aria-busy')).toBe('true');
  });

  it('uses the host test id for the notice and its button', () => {
    render({
      failure: WITH_FALLBACK,
      onUseFallback: jest.fn(),
      dataTestId: 'portal-chat-codex-account-model-notice',
    });
    expect(
      container.querySelector(
        '[data-testid="portal-chat-codex-account-model-notice"]',
      ),
    ).not.toBeNull();
    expect(button('portal-chat-codex-account-model-notice')).not.toBeNull();
  });
});
