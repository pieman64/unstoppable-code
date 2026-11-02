/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StuckAgentNotice,
  type StuckAgentCheckResult,
} from '../StuckAgentNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('StuckAgentNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function query<T extends HTMLElement>(selector: string): T | null {
    return container.querySelector<T>(selector);
  }

  function render(
    onCheckStatus: () => Promise<StuckAgentCheckResult>,
    minutes = 6,
  ): void {
    act(() =>
      root.render(
        <StuckAgentNotice minutes={minutes} onCheckStatus={onCheckStatus} />,
      ),
    );
  }

  it('renders the not-checked warning and check action', () => {
    render(
      jest.fn((): Promise<StuckAgentCheckResult> => Promise.resolve('running')),
    );

    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'No response for 6 minutes.',
    );
    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'The agent might be stuck.',
    );
    const button = query<HTMLButtonElement>(
      '[data-testid="stuck-agent-check-status"]',
    );
    expect(button?.textContent).toBe('Check status');
    expect(button?.disabled).toBe(false);
  });

  it('uses the singular minute in the title', () => {
    render(
      jest.fn((): Promise<StuckAgentCheckResult> => Promise.resolve('settled')),
      1,
    );

    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'No response for 1 minute.',
    );
  });

  it('disables the action while checking and ignores a double click', async () => {
    let resolveCheck: ((result: StuckAgentCheckResult) => void) | undefined;
    const onCheckStatus = jest.fn(
      () =>
        new Promise<StuckAgentCheckResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    render(onCheckStatus);

    const button = query<HTMLButtonElement>(
      '[data-testid="stuck-agent-check-status"]',
    );
    act(() => {
      button?.click();
      button?.click();
    });

    expect(onCheckStatus).toHaveBeenCalledTimes(1);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');

    if (!resolveCheck) throw new Error('Expected the check to be pending');
    const resolve = resolveCheck;
    await act(async () => {
      resolve('running');
      await Promise.resolve();
    });
  });

  it('shows a running result without an action', async () => {
    const onCheckStatus = jest.fn(
      (): Promise<StuckAgentCheckResult> => Promise.resolve('running'),
    );
    render(onCheckStatus);

    const button = query<HTMLButtonElement>(
      '[data-testid="stuck-agent-check-status"]',
    );
    act(() => button?.click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'The agent is still working.',
    );
    expect(query('[data-testid="stuck-agent-check-status"]')).toBeNull();
  });

  it('shows failure detail and makes the action available again', async () => {
    const onCheckStatus = jest.fn(
      (): Promise<StuckAgentCheckResult> =>
        Promise.reject(new Error('temporary failure')),
    );
    render(onCheckStatus);

    act(() =>
      query<HTMLButtonElement>(
        '[data-testid="stuck-agent-check-status"]',
      )?.click(),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      "Couldn't check the agent's status.",
    );
    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'The agent might be stuck.',
    );
    expect(query('[data-testid="stuck-agent-check-status"]')?.textContent).toBe(
      'Check status',
    );
  });

  it('returns to the not-checked state when the status has settled', async () => {
    const onCheckStatus = jest.fn(
      (): Promise<StuckAgentCheckResult> => Promise.resolve('settled'),
    );
    render(onCheckStatus);

    act(() =>
      query<HTMLButtonElement>(
        '[data-testid="stuck-agent-check-status"]',
      )?.click(),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(query('[data-testid="stuck-agent-warning"]')?.textContent).toContain(
      'The agent might be stuck.',
    );
    expect(query('[data-testid="stuck-agent-check-status"]')?.textContent).toBe(
      'Check status',
    );
    expect(
      query('[data-testid="stuck-agent-warning"]')?.textContent,
    ).not.toContain("Couldn't check the agent's status.");
  });
});
