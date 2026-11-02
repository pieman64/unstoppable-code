/** @jest-environment jsdom */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient, DomainEventMap } from '@canopy/app-core';
import type { ManagedDelegationLifetimeStatus } from '@canopy/protocol/delegation';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import {
  LifetimeLimitNotice,
  type LifetimeLimitNoticeProps,
} from '../LifetimeLimitNoticeContainer';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const target = { projectId: 'project', worktreeId: 'worktree' };
const full: ManagedDelegationLifetimeStatus = {
  kind: 'available',
  occupied: 512,
  retained: 511,
  limit: 512,
  cap: 1024,
  atLimit: true,
  canExtend: true,
  atCap: false,
  refusedChatIds: ['refused'],
};
const below: ManagedDelegationLifetimeStatus = {
  ...full,
  occupied: 511,
  retained: 511,
  atLimit: false,
  refusedChatIds: [],
};
function setup(): {
  client: CanopyClient;
  query: jest.Mock;
  command: jest.Mock;
  subscribed: string[];
  unsubscribed: string[];
  emit: (
    name: 'delegation.lifetimeChanged',
    event: DomainEventMap['delegation.lifetimeChanged'],
  ) => void;
} {
  const query = jest.fn();
  const command = jest.fn();
  const subscribe = jest.fn();
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const listeners = new Set<
    (event: DomainEventMap['delegation.lifetimeChanged']) => void
  >();
  subscribe.mockImplementation(
    (
      name: string,
      handler: (event: DomainEventMap['delegation.lifetimeChanged']) => void,
    ): (() => void) => {
      subscribed.push(name);
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
        unsubscribed.push(name);
      };
    },
  );
  const client: CanopyClient = {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'crud-only',
      routing: 'url',
      overviewNotifications: false,
      delegationLifetimeStatusReads: true,
      delegationLifetimeLimitExtension: true,
    },
    query,
    command,
    subscribe,
  };
  const emit = (
    _name: 'delegation.lifetimeChanged',
    event: DomainEventMap['delegation.lifetimeChanged'],
  ): void => {
    listeners.forEach((handler) => handler(event));
  };
  return { client, query, command, subscribed, unsubscribed, emit };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('LifetimeLimitNotice container', () => {
  let root: Root;
  let element: HTMLDivElement;
  beforeEach(() => {
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flush();
    });
    element.remove();
  });
  async function render(
    client: CanopyClient,
    notices: LifetimeLimitNoticeProps[],
  ): Promise<void> {
    await act(async () => {
      root.render(
        <StrictMode>
          <CanopyClientProvider client={client}>
            {notices.map((props, index) => (
              <section key={index} data-testid={`slot-${index}`}>
                <LifetimeLimitNotice {...props} />
              </section>
            ))}
          </CanopyClientProvider>
        </StrictMode>,
      );
      await flush();
    });
  }
  const slot = (index: number): Element | null =>
    element.querySelector(`[data-testid="slot-${index}"]`);

  test('initial mount without a status reserves no notice space', async () => {
    const { client, query } = setup();
    query.mockReturnValue(new Promise(() => undefined));
    await render(client, [{ ...target, placement: 'panel' }]);
    expect(slot(0)?.textContent).toBe('');
  });
  test('panel shows reservation-based full status; only the refused chat shows it', async () => {
    const { client, query } = setup();
    query.mockResolvedValue(full);
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
      { ...target, placement: 'chat', chatId: 'another-chat' },
    ]);
    expect(slot(0)?.textContent).toContain('Lifetime limit reached');
    expect(slot(1)?.textContent).toContain('Lifetime limit reached');
    expect(slot(2)?.textContent).toBe('');
    expect(query).toHaveBeenCalledTimes(1);
  });
  test('insets the panel notice to the panel padding; the composer notice keeps its column', async () => {
    const { client, query } = setup();
    query.mockResolvedValue(full);
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    const panelInset = slot(0)?.firstElementChild;
    expect(panelInset?.className).toBe('shrink-0 px-3 pt-2');
    expect(
      panelInset?.querySelector('[data-testid="lifetime-limit-notice"]'),
    ).not.toBeNull();
    expect(slot(1)?.firstElementChild?.getAttribute('data-testid')).toBe(
      'lifetime-limit-notice',
    );
  });
  test('below the limit hides both placements, even with a refused id', async () => {
    const { client, query } = setup();
    query.mockResolvedValue({ ...below, refusedChatIds: ['refused'] });
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(element.textContent).toBe('');
  });
  test('a different worktree remains untouched by this worktree becoming full', async () => {
    const { client, query, emit } = setup();
    query.mockResolvedValue(below);
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, worktreeId: 'other', placement: 'panel' },
    ]);
    query.mockResolvedValue(full);
    await act(async () => {
      emit('delegation.lifetimeChanged', {
        ...target,
        occurredAt: '2026-10-22T00:00:01.000Z',
      });
      await flush();
    });
    expect(slot(0)?.textContent).toContain('Lifetime limit reached');
    expect(slot(1)?.textContent).toBe('');
  });
  test.each([
    { kind: 'unavailable', reason: 'unreadable' },
    { kind: 'unavailable', reason: 'uncertain' },
    { kind: 'error', reason: 'read_failed' },
    { kind: 'unsupported' },
  ])(
    'unreadable or uncertain status never claims limit reached: %j',
    async (status) => {
      const { client, query } = setup();
      query.mockResolvedValue(status);
      await render(client, [
        { ...target, placement: 'panel' },
        { ...target, placement: 'chat', chatId: 'refused' },
      ]);
      expect(slot(0)?.textContent).toContain(
        "Couldn't read this worktree's lifetime limit",
      );
      expect(element.textContent).not.toContain('limit reached');
      expect(slot(1)?.textContent).toBe('');
    },
  );
  test('capability-gated panel is static, with no status read or chat notice', async () => {
    const { client: base, query, subscribed } = setup();
    const client: CanopyClient = {
      ...base,
      capabilities: {
        ...base.capabilities,
        delegationLifetimeStatusReads: false,
        delegationLifetimeStatusGated: true,
      },
    };
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(slot(0)?.textContent).toContain(
      "can't show or change this worktree's lifetime limit",
    );
    expect(slot(1)?.textContent).toBe('');
    expect(
      element.querySelector('[role="status"], [role="alert"], button'),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(subscribed).toEqual([]);
  });
  test('cloud-like client with neither read nor gate renders nothing', async () => {
    const { client: base, query } = setup();
    const client: CanopyClient = {
      ...base,
      capabilities: {
        ...base.capabilities,
        delegationLifetimeStatusReads: false,
        delegationLifetimeStatusGated: false,
      },
    };
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(element.textContent).toBe('');
    expect(query).not.toHaveBeenCalled();
  });
  test('target-scoped capabilities override global reads and use the local worktree id', async () => {
    const { client: base, query } = setup();
    const capabilitiesFor = jest.fn(() => ({
      ...base.capabilities,
      delegationLifetimeStatusReads: false,
      delegationLifetimeStatusGated: true,
    }));
    await render({ ...base, capabilitiesFor }, [
      { ...target, placement: 'panel' },
    ]);
    expect(capabilitiesFor).toHaveBeenCalledWith('worktree');
    expect(element.textContent).toContain(
      "can't show or change this worktree's lifetime limit",
    );
    expect(query).not.toHaveBeenCalled();
  });
  test('at-cap and command-gated full notices offer no action', async () => {
    const { client, query } = setup();
    query.mockResolvedValue({
      ...full,
      cap: 512,
      canExtend: false,
      atCap: true,
    });
    await render(client, [{ ...target, placement: 'panel' }]);
    expect(element.textContent).toContain(
      "this build's maximum lifetime limit",
    );
    expect(element.querySelector('button')).toBeNull();
    const next = setup();
    next.query.mockResolvedValue(full);
    await render(
      {
        ...next.client,
        capabilities: {
          ...next.client.capabilities,
          delegationLifetimeLimitExtension: false,
        },
      },
      [{ ...target, placement: 'panel' }],
    );
    expect(element.querySelector('button')).toBeNull();
    expect(element.textContent).not.toContain('Extend');
  });
  test('one extension disables both actions and confirmed capacity clears panel and chat without retrying an agent', async () => {
    const { client, query, command } = setup();
    query.mockResolvedValue(full);
    let confirm: (value: unknown) => void = () => undefined;
    command.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(element.querySelectorAll('button')).toHaveLength(2);
    await act(async () => {
      element.querySelector('button')?.click();
      await flush();
    });
    expect(
      Array.from(element.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    query.mockResolvedValue(below);
    await act(async () => {
      confirm({ ok: true, baseline: 512, effectiveLimit: 1024, retained: 512 });
      await flush();
    });
    expect(element.textContent).toBe('');
    expect(command).toHaveBeenCalledWith(
      'delegation.extendLifetimeLimit',
      target,
    );
    expect(command).toHaveBeenCalledTimes(1);
  });
  test('extension failure keeps both notices and reports the failure', async () => {
    const { client, query, command } = setup();
    query.mockResolvedValue(full);
    command.mockResolvedValue({ ok: false, reason: 'no_increase' });
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(element.querySelectorAll('button')).toHaveLength(2);
    await act(async () => {
      element.querySelector('button')?.click();
      await flush();
    });
    expect(slot(0)?.textContent).toContain("The extension didn't apply.");
    expect(slot(1)?.textContent).toContain("The extension didn't apply.");
    expect(query).toHaveBeenCalledTimes(1);
  });
  test('provider disposal releases its single transport subscription', async () => {
    const { client, query, subscribed, unsubscribed } = setup();
    query.mockResolvedValue(full);
    await render(client, [
      { ...target, placement: 'panel' },
      { ...target, placement: 'chat', chatId: 'refused' },
    ]);
    expect(subscribed).toEqual(['delegation.lifetimeChanged']);
    await act(async () => {
      root.render(null);
      await flush();
    });
    expect(unsubscribed).toEqual(['delegation.lifetimeChanged']);
  });
});
