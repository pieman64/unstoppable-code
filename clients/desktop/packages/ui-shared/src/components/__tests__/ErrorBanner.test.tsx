/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBanner } from '../StatusBlocks';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ErrorBanner', () => {
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

  const render = (error: string | null | undefined): void => {
    act(() => {
      root.render(<ErrorBanner error={error} />);
    });
  };

  const notice = (): HTMLElement | null =>
    container.querySelector('[data-notice-intent="destructive"]');

  it('blocks only the error text when it can quote command output', () => {
    act(() => {
      root.render(
        <ErrorBanner
          error="Install failed. Output: token abc123 rejected"
          blockMessageFromReplay
        />,
      );
    });
    const blocked = notice()?.querySelectorAll('.ph-no-capture') ?? [];
    expect(Array.from(blocked).map((node) => node.textContent)).toEqual([
      'Install failed.',
      'Output: token abc123 rejected',
    ]);
    expect(notice()?.closest('.ph-no-capture')).toBeNull();
    render('Install failed. Try again.');
    expect(notice()?.querySelector('.ph-no-capture')).toBeNull();
  });

  it('renders nothing without an error', () => {
    render(null);
    expect(notice()).toBeNull();
    render('');
    expect(notice()).toBeNull();
  });

  it.each([
    ["Couldn't load skills. Try again.", "Couldn't load skills.", 'Try again.'],
    [
      'Request failed! Retry in a moment.',
      'Request failed!',
      'Retry in a moment.',
    ],
    ['  Saved? Not yet. Check the log.  ', 'Saved?', 'Not yet. Check the log.'],
  ])(
    'leads with the first sentence as the title: %s',
    (error, title, message) => {
      render(error);
      expect(notice()?.querySelector('span.fg-primary')?.textContent).toBe(
        title,
      );
      expect(notice()?.querySelector('span.fg-tertiary')?.textContent).toBe(
        message,
      );
      expect(notice()?.textContent).toBe(`${title} ${message}`);
    },
  );

  it('keeps an abbreviation before a lowercase word inside the title', () => {
    render('Retry failed (e.g. timeouts). Try again.');
    expect(notice()?.querySelector('span.fg-primary')?.textContent).toBe(
      'Retry failed (e.g. timeouts).',
    );
    expect(notice()?.querySelector('span.fg-tertiary')?.textContent).toBe(
      'Try again.',
    );
  });

  it('trims an untrimmed single-sentence error', () => {
    render('  Something went wrong  ');
    expect(notice()?.textContent).toBe('Something went wrong');
  });

  it.each(['Couldn’t load skills.', 'Something went wrong'])(
    'keeps a single-sentence error as the whole message: %s',
    (error) => {
      render(error);
      expect(notice()?.textContent).toBe(error);
      expect(notice()?.querySelector('span.fg-tertiary')).toBeNull();
    },
  );

  it('renders a Try again action in the notice actions slot', () => {
    const onRetry = jest.fn();
    act(() => {
      root.render(
        <ErrorBanner
          error="Couldn't load this. Try again."
          onRetry={onRetry}
        />,
      );
    });
    const button = notice()?.querySelector('button');
    expect(button?.textContent).toBe('Try again');
    expect(button?.getAttribute('type')).toBe('button');
    // The button says it, so the message drops its own closing `Try again.`
    expect(notice()?.textContent).toBe("Couldn't load this.Try again");
    act(() => {
      button?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('labels the retry action with retryLabel, also on a one-sentence error', () => {
    act(() => {
      root.render(
        <ErrorBanner
          error="Couldn't load members"
          onRetry={jest.fn()}
          retryLabel="Retry members"
        />,
      );
    });
    expect(notice()?.querySelector('button')?.textContent).toBe(
      'Retry members',
    );
  });

  it('shows no action without onRetry, and keeps the copy whole', () => {
    render("Couldn't load this. Try again.");
    expect(notice()?.querySelector('button')).toBeNull();
    expect(notice()?.textContent).toBe("Couldn't load this. Try again.");
  });

  it('keeps the copy whole beside a differently named action', () => {
    act(() => {
      root.render(
        <ErrorBanner
          error="Couldn't scan scripts. Try again."
          onRetry={jest.fn()}
          retryLabel="Rescan"
        />,
      );
    });
    expect(notice()?.textContent).toBe(
      "Couldn't scan scripts. Try again.Rescan",
    );
  });

  it('keeps a reason that only starts with Try again', () => {
    act(() => {
      root.render(
        <ErrorBanner
          error="GitHub rate limit reached. Try again in a minute."
          onRetry={jest.fn()}
        />,
      );
    });
    expect(notice()?.textContent).toContain('Try again in a minute.');
  });
});
