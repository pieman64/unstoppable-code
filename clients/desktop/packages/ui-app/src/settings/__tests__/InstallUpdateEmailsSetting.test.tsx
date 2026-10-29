/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { InstallUpdateEmailsSetting } from '../InstallUpdateEmailsSetting';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'limited',
  pipelines: 'view-only',
  routing: 'portal',
  overviewNotifications: false,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeClient extends CanopyClient {
  readonly queries: string[];
  readonly commands: Array<{ name: string; args: unknown }>;
}

/**
 * A client whose `get` and `set` results are handed out in call order from
 * the given queues, so a test controls when each request settles.
 */
function createClient(options: {
  readonly capability?: boolean;
  readonly loads?: Array<Deferred<{ enabled: boolean }>>;
  readonly saves?: Array<Deferred<{ enabled: boolean }>>;
}): FakeClient {
  const loads = [...(options.loads ?? [])];
  const saves = [...(options.saves ?? [])];
  const queries: string[] = [];
  const commands: Array<{ name: string; args: unknown }> = [];
  return {
    queries,
    commands,
    capabilities: {
      ...BASE_CAPABILITIES,
      ...(options.capability === undefined
        ? {}
        : { installUpdateEmails: options.capability }),
    },
    query<K extends QueryName>(name: K): Promise<QueryMap[K]['result']> {
      queries.push(name);
      const next = loads.shift();
      if (name !== 'account.installUpdateEmails.get' || !next) {
        return Promise.reject(new Error(`unexpected query ${name}`));
      }
      // The fake only answers the one query it is built for.
      return next.promise as Promise<QueryMap[K]['result']>;
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      commands.push({ name, args });
      const next = saves.shift();
      if (name !== 'account.installUpdateEmails.set' || !next) {
        return Promise.reject(new Error(`unexpected command ${name}`));
      }
      return next.promise as Promise<CommandMap[K]['result']>;
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

describe('InstallUpdateEmailsSetting', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(client: CanopyClient): void {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <InstallUpdateEmailsSetting />
        </CanopyClientProvider>,
      );
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function find(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function toggle(): HTMLButtonElement | null {
    const element = find('install-update-emails-toggle');
    return element instanceof HTMLButtonElement ? element : null;
  }

  it('renders nothing and never queries when the capability is unset', () => {
    const client = createClient({});
    render(client);
    expect(container.innerHTML).toBe('');
    expect(client.queries).toEqual([]);
  });

  it('renders nothing when the capability is false', () => {
    const client = createClient({ capability: false });
    render(client);
    expect(container.innerHTML).toBe('');
    expect(client.queries).toEqual([]);
  });

  it('shows a form skeleton and no switch while loading, then the server value', async () => {
    const load = deferred<{ enabled: boolean }>();
    render(createClient({ capability: true, loads: [load] }));

    const skeleton = find('settings-skeleton-form');
    expect(skeleton?.getAttribute('role')).toBe('status');
    expect(find('install-update-emails-setting')?.textContent).not.toContain(
      'Loading…',
    );
    expect(toggle()).toBeNull();

    load.resolve({ enabled: false });
    await settle();

    expect(find('settings-skeleton-form')).toBeNull();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(toggle()?.disabled).toBe(false);
    expect(find('install-update-emails-setting')?.textContent).toContain(
      'Get an email when someone updates a skill, pipeline, automation or other item you installed.',
    );
  });

  it('disables the switch while saving and shows the value the server returned', async () => {
    const load = deferred<{ enabled: boolean }>();
    const save = deferred<{ enabled: boolean }>();
    const client = createClient({
      capability: true,
      loads: [load],
      saves: [save],
    });
    render(client);
    load.resolve({ enabled: true });
    await settle();

    act(() => toggle()?.click());
    // Pessimistic: still the server value, and locked against a second click.
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.disabled).toBe(true);
    act(() => toggle()?.click());
    expect(client.commands).toEqual([
      { name: 'account.installUpdateEmails.set', args: { enabled: false } },
    ]);

    // The server's answer wins, even when it differs from the request.
    save.resolve({ enabled: true });
    await settle();
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.disabled).toBe(false);
  });

  it('sends one save for two clicks that land before the disabled state renders', async () => {
    const load = deferred<{ enabled: boolean }>();
    const save = deferred<{ enabled: boolean }>();
    const client = createClient({
      capability: true,
      loads: [load],
      saves: [save],
    });
    render(client);
    load.resolve({ enabled: true });
    await settle();

    // One act batches both clicks, so the second sees the pre-save render.
    act(() => {
      toggle()?.click();
      toggle()?.click();
    });
    expect(client.commands).toHaveLength(1);

    save.resolve({ enabled: false });
    await settle();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the last server value when a save fails, and Retry resends the request', async () => {
    const load = deferred<{ enabled: boolean }>();
    const failedSave = deferred<{ enabled: boolean }>();
    const retriedSave = deferred<{ enabled: boolean }>();
    const client = createClient({
      capability: true,
      loads: [load],
      saves: [failedSave, retriedSave],
    });
    render(client);
    load.resolve({ enabled: true });
    await settle();

    act(() => toggle()?.click());
    failedSave.reject(new Error('offline'));
    await settle();

    const saveError = find('install-update-emails-error')?.textContent;
    expect(saveError).toContain("Couldn't save this setting. Try again.");
    expect(saveError).not.toContain('offline');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.disabled).toBe(false);

    act(() => find('install-update-emails-retry')?.click());
    expect(client.commands).toEqual([
      { name: 'account.installUpdateEmails.set', args: { enabled: false } },
      { name: 'account.installUpdateEmails.set', args: { enabled: false } },
    ]);
    retriedSave.resolve({ enabled: false });
    await settle();

    expect(find('install-update-emails-error')).toBeNull();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('locks without a switch when the load fails, never saving, and Retry reloads', async () => {
    const failedLoad = deferred<{ enabled: boolean }>();
    const retriedLoad = deferred<{ enabled: boolean }>();
    const client = createClient({
      capability: true,
      loads: [failedLoad, retriedLoad],
    });
    render(client);
    failedLoad.reject(new Error('UNAVAILABLE'));
    await settle();

    const loadError = find('install-update-emails-error')?.textContent;
    expect(loadError).toContain("Couldn't load this. Try again.");
    expect(loadError).not.toContain('UNAVAILABLE');
    expect(toggle()).toBeNull();
    expect(client.commands).toEqual([]);

    act(() => find('install-update-emails-retry')?.click());
    retriedLoad.resolve({ enabled: true });
    await settle();

    expect(client.queries).toEqual([
      'account.installUpdateEmails.get',
      'account.installUpdateEmails.get',
    ]);
    expect(find('install-update-emails-error')).toBeNull();
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(client.commands).toEqual([]);
  });

  it('renders the default heading, or the host frame around the row', async () => {
    const load = deferred<{ enabled: boolean }>();
    render(createClient({ capability: true, loads: [load] }));
    expect(container.querySelector('h2')?.textContent).toBe('Update emails');

    const hostLoad = deferred<{ enabled: boolean }>();
    act(() => {
      root.render(
        <CanopyClientProvider
          client={createClient({ capability: true, loads: [hostLoad] })}
        >
          <InstallUpdateEmailsSetting
            renderFrame={(content) => (
              <article data-testid="host-frame">{content}</article>
            )}
          />
        </CanopyClientProvider>,
      );
    });
    hostLoad.resolve({ enabled: true });
    await settle();
    const frame = find('host-frame');
    expect(frame?.querySelector('h2')).toBeNull();
    expect(
      frame?.querySelector('[data-testid="install-update-emails-toggle"]'),
    ).not.toBeNull();
  });

  it('flips the switch when its visible label is clicked', async () => {
    const load = deferred<{ enabled: boolean }>();
    const save = deferred<{ enabled: boolean }>();
    const client = createClient({
      capability: true,
      loads: [load],
      saves: [save],
    });
    render(client);
    load.resolve({ enabled: true });
    await settle();

    act(() => container.querySelector('label')?.click());
    expect(client.commands).toEqual([
      { name: 'account.installUpdateEmails.set', args: { enabled: false } },
    ]);
  });
});
