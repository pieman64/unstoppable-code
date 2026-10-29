/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountLabsResponse } from '@canopy/protocol/experiments';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import { LabsPage } from '../LabsPage';
import { LabsSettingsPortProvider } from '../labs-settings-port';

const CLEAN_CHAT = {
  id: 'clean-chat',
  name: 'Clean chat',
  description: 'A quieter chat.',
};

function labs(enabled: boolean): AccountLabsResponse {
  return { experiments: [{ ...CLEAN_CHAT, enabled }] };
}

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
    Record<'account.labs.read' | 'account.labs.update', FakeSettingsHandler>
  >,
  wrap: (node: ReactNode) => ReactNode = (node) => node,
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
      <TestSettingsHost host={host}>{wrap(<LabsPage />)}</TestSettingsHost>,
    );
    await flush();
  });
  return { element, calls: client.calls };
}

function toggle(element: HTMLElement): HTMLButtonElement {
  const button = element.querySelector<HTMLButtonElement>(
    '[data-testid="labs-experiment-toggle-clean-chat"]',
  );
  if (button === null) throw new Error('Expected the Clean chat switch.');
  return button;
}

describe('LabsPage', () => {
  it('lists what account Labs returns and saves a choice', async () => {
    let resolveSave: (value: AccountLabsResponse) => void = () => {};
    const { element, calls } = await render({
      'account.labs.read': () => labs(false),
      'account.labs.update': () =>
        new Promise<AccountLabsResponse>((resolve) => {
          resolveSave = resolve;
        }),
    });
    expect(element.textContent).toContain('Clean chat');
    expect(toggle(element).getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      toggle(element).click();
      await flush();
    });
    // The switch shows the request and holds still while it saves.
    expect(toggle(element).getAttribute('aria-checked')).toBe('true');
    expect(toggle(element).disabled).toBe(true);
    expect(calls.at(-1)).toEqual({
      operation: 'account.labs.update',
      input: { experimentId: 'clean-chat', enabled: true },
    });

    await act(async () => {
      resolveSave(labs(true));
      await flush();
    });
    expect(toggle(element).getAttribute('aria-checked')).toBe('true');
    expect(toggle(element).disabled).toBe(false);
  });

  it('goes back and says so when a save fails', async () => {
    const { element } = await render({
      'account.labs.read': () => labs(false),
      'account.labs.update': () => {
        throw new SettingsOperationError({
          code: 'failed',
          message: 'boom',
        });
      },
    });
    await act(async () => {
      toggle(element).click();
      await flush();
    });
    expect(toggle(element).getAttribute('aria-checked')).toBe('false');
    expect(element.querySelector('[role="alert"]')).not.toBe(null);
    expect(element.textContent).not.toContain('boom');
  });

  it('says when there is nothing to try', async () => {
    const { element } = await render({
      'account.labs.read': () => ({ experiments: [] }),
    });
    expect(
      element.querySelector('[data-testid="account-labs-empty"]'),
    ).not.toBe(null);
  });

  it("lists through the host's own Labs port when it has one", async () => {
    const onToggle = jest.fn();
    const { element, calls } = await render({}, (node) => (
      <LabsSettingsPortProvider
        value={{
          rows: [{ ...CLEAN_CHAT, checked: true, disabled: false }],
          error: null,
          onToggle,
        }}
      >
        {node}
      </LabsSettingsPortProvider>
    ));
    expect(calls).toHaveLength(0);
    act(() => toggle(element).click());
    expect(onToggle).toHaveBeenCalledWith('clean-chat', false);
  });
});
