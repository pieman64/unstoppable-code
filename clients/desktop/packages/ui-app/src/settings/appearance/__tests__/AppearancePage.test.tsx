/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountAppearance } from '@canopy/protocol/chat-detail';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import { AppearancePage } from '../AppearancePage';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function render(
  handlers: Partial<
    Record<
      'account.appearance.read' | 'account.appearance.update',
      FakeSettingsHandler
    >
  >,
): Promise<{
  element: HTMLElement;
  calls: ReturnType<typeof createFakeSettingsClient>['calls'];
}> {
  const client = createFakeSettingsClient(handlers);
  const { host } = createTestSettingsHost({ client });
  const element = document.createElement('div');
  document.body.appendChild(element);
  container = element;
  await act(async () => {
    root = createRoot(element);
    root.render(
      <TestSettingsHost host={host}>
        <AppearancePage />
      </TestSettingsHost>,
    );
    await flush();
  });
  return { element, calls: client.calls };
}

function segment(element: HTMLElement, level: string): HTMLButtonElement {
  const button = element.querySelector<HTMLButtonElement>(
    `[data-testid="chat-detail-${level}"]`,
  );
  if (button === null) throw new Error(`Expected the ${level} segment.`);
  return button;
}

function description(element: HTMLElement): string {
  return (
    element.querySelector('[data-testid="settings-chat-detail-row"]')
      ?.textContent ?? ''
  );
}

describe('AppearancePage', () => {
  it('shows the saved level and saves a new one', async () => {
    let resolveSave: (value: AccountAppearance) => void = () => {};
    const { element, calls } = await render({
      'account.appearance.read': () => ({ chatDetail: 'recent' }),
      'account.appearance.update': () =>
        new Promise<AccountAppearance>((resolve) => {
          resolveSave = resolve;
        }),
    });
    expect(element.textContent).toContain('Chat detail');
    expect(segment(element, 'recent').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(description(element)).toContain('latest 3 steps stay in view');

    await act(async () => {
      segment(element, 'compact').click();
      await flush();
    });
    // The picker shows the request while it saves.
    expect(segment(element, 'compact').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(calls.at(-1)).toEqual({
      operation: 'account.appearance.update',
      input: { chatDetail: 'compact' },
    });

    await act(async () => {
      resolveSave({ chatDetail: 'compact' });
      await flush();
    });
    expect(segment(element, 'compact').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(description(element)).toContain('Open a row to see each step.');
  });

  it('sends overlapping picks in order, so the latest pick is stored last', async () => {
    const resolvers: Array<(value: AccountAppearance) => void> = [];
    const { element, calls } = await render({
      'account.appearance.read': () => ({ chatDetail: 'recent' }),
      'account.appearance.update': (input) =>
        new Promise<AccountAppearance>((resolve) => {
          resolvers.push(() => resolve(input as AccountAppearance));
        }),
    });
    await act(async () => {
      segment(element, 'compact').click();
      await flush();
      segment(element, 'detailed').click();
      await flush();
    });
    const updates = (): unknown[] =>
      calls
        .filter((call) => call.operation === 'account.appearance.update')
        .map((call) => call.input);
    // The second pick waits for the first save to finish.
    expect(updates()).toEqual([{ chatDetail: 'compact' }]);
    expect(segment(element, 'detailed').getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => {
      resolvers[0]?.({ chatDetail: 'compact' });
      await flush();
    });
    expect(updates()).toEqual([
      { chatDetail: 'compact' },
      { chatDetail: 'detailed' },
    ]);
    await act(async () => {
      resolvers[1]?.({ chatDetail: 'detailed' });
      await flush();
    });
    expect(segment(element, 'detailed').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('goes back to the last stored pick when a later queued save fails', async () => {
    let count = 0;
    const { element } = await render({
      'account.appearance.read': () => ({ chatDetail: 'recent' }),
      'account.appearance.update': (input) => {
        count += 1;
        if (count === 2)
          throw new SettingsOperationError({ code: 'failed', message: 'x' });
        return input;
      },
    });
    await act(async () => {
      segment(element, 'compact').click();
      segment(element, 'detailed').click();
      await flush();
    });
    // Compact was stored; Detailed failed, so the picker shows Compact.
    expect(segment(element, 'compact').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(element.querySelector('[role="alert"]')).not.toBe(null);
  });

  it('goes back and says so when a save fails', async () => {
    const { element } = await render({
      'account.appearance.read': () => ({ chatDetail: 'detailed' }),
      'account.appearance.update': () => {
        throw new SettingsOperationError({ code: 'failed', message: 'boom' });
      },
    });
    await act(async () => {
      segment(element, 'recent').click();
      await flush();
    });
    expect(segment(element, 'detailed').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(element.querySelector('[role="alert"]')).not.toBe(null);
    expect(element.textContent).not.toContain('boom');
  });

  it('offers a retry when the level cannot be read', async () => {
    let fail = true;
    const { element } = await render({
      'account.appearance.read': () => {
        if (fail)
          throw new SettingsOperationError({ code: 'failed', message: 'x' });
        return { chatDetail: 'detailed' };
      },
    });
    expect(element.querySelector('[data-testid="chat-detail-detailed"]')).toBe(
      null,
    );
    fail = false;
    const retry = Array.from(element.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await act(async () => {
      retry?.click();
      await flush();
    });
    expect(segment(element, 'detailed').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
