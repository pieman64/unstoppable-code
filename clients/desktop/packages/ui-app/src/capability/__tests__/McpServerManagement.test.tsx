/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  McpServerHealthSection,
  McpServerManagementActions,
  type McpServerHealthSectionProps,
  type McpServerManagementActionsProps,
  type McpTestConnectionOutcome,
} from '../McpServerManagement';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const element = byTestId(id);
  if (!element) throw new Error(`missing ${id}`);
  act(() => element.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CONFIGS = [
  { id: 'personal', name: 'Personal' },
  { id: 'work', name: 'Work' },
];

function renderHealth(props: Partial<McpServerHealthSectionProps> = {}): void {
  act(() =>
    root.render(
      <McpServerHealthSection
        targetKey="server-1"
        configs={CONFIGS}
        formatTimestamp={(iso) => `at ${iso}`}
        {...props}
      />,
    ),
  );
}

describe('McpServerHealthSection', () => {
  it('shows Not checked and no recorded check without status', () => {
    renderHealth();
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Not checked');
    expect(byTestId('mcp-health-last-checked')?.textContent).toBe(
      'No recorded check',
    );
    expect(byTestId('mcp-health-test')).toBeNull();
  });

  it('shows cached status, its recorded time and per-config auth', () => {
    renderHealth({
      status: {
        connectionStatus: 'auth_required',
        reachability: 'reachable',
        lastCheckedAt: '2026-10-01T10:00:00.000Z',
        configs: [
          { configId: 'work', authStatus: 'expired' },
          { configId: 'gone', authStatus: 'connected' },
          { configId: 'personal', authStatus: 'mystery' },
        ],
      },
    });
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Auth required');
    expect(byTestId('mcp-health-last-checked')?.textContent).toBe(
      'Last checked at 2026-10-01T10:00:00.000Z',
    );
    expect(byTestId('mcp-health-auth-work')?.textContent).toContain('Expired');
    expect(byTestId('mcp-health-auth-gone')).toBeNull();
    expect(byTestId('mcp-health-auth-personal')).toBeNull();
  });

  it('ignores an invalid timestamp rather than inventing freshness', () => {
    renderHealth({
      status: {
        connectionStatus: 'connected',
        reachability: 'reachable',
        lastCheckedAt: 'not a date',
        configs: [],
      },
    });
    expect(byTestId('mcp-health-last-checked')?.textContent).toBe(
      'No recorded check',
    );
  });

  it('titles the default presentation with a Health heading', () => {
    renderHealth();
    const section = byTestId('mcp-health-section');
    const heading = section?.querySelector('h3');
    expect(heading?.textContent).toBe('Health');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(section?.hasAttribute('aria-label')).toBe(false);
  });

  it('inline presentation omits the Health heading and keeps badge, last-checked and test ids (CAN-4842)', async () => {
    const run = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
    } satisfies McpTestConnectionOutcome);
    const onTested = jest.fn();
    renderHealth({
      presentation: 'inline',
      configs: [CONFIGS[0]],
      status: {
        connectionStatus: 'connected',
        reachability: 'reachable',
        lastCheckedAt: '2026-10-01T10:00:00.000Z',
        configs: [{ configId: 'personal', authStatus: 'connected' }],
      },
      testConnection: { available: true, run },
      onTested,
    });
    const section = byTestId('mcp-health-section');
    expect(section?.querySelector('h3')).toBeNull();
    // One per server row: a group, not a repeated "Health" landmark.
    expect(section?.tagName).toBe('DIV');
    expect(section?.getAttribute('role')).toBe('group');
    expect(section?.getAttribute('aria-label')).toBe('Health');
    expect(section?.hasAttribute('aria-labelledby')).toBe(false);
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Connected');
    expect(byTestId('mcp-health-last-checked')?.textContent).toBe(
      'Last checked at 2026-10-01T10:00:00.000Z',
    );
    expect(byTestId('mcp-health-auth-personal')).not.toBeNull();
    click('mcp-health-test');
    await flush();
    expect(run).toHaveBeenCalledWith('personal');
    expect(onTested).toHaveBeenCalledTimes(1);
    expect(byTestId('mcp-health-result')).not.toBeNull();
  });

  it('inline presentation explains an unavailable test', () => {
    renderHealth({
      presentation: 'inline',
      testConnection: { available: false, reason: 'Not here.' },
    });
    const button = byTestId('mcp-health-test');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('mcp-health-test-reason')?.textContent).toBe('Not here.');
    expect(button?.getAttribute('aria-describedby')).toBe(
      byTestId('mcp-health-test-reason')?.id,
    );
  });

  it('uses the account fallback without cached status', () => {
    renderHealth({ accountConnectionStatus: 'CONNECTED' });
    expect(byTestId('mcp-health-badge')?.textContent).toBe('Connected');
  });

  it('tests the selected configuration and shows the result', async () => {
    const run = jest.fn(
      (): Promise<McpTestConnectionOutcome> =>
        Promise.resolve({
          success: true,
          message: 'OK',
          tools: ['search', 'fetch'],
          responseTime: 41.6,
        }),
    );
    const onTested = jest.fn();
    renderHealth({ testConnection: { available: true, run }, onTested });
    const select = byTestId('mcp-health-config-select');
    if (!(select instanceof HTMLSelectElement)) throw new Error('no select');
    act(() => {
      select.value = 'work';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click('mcp-health-test');
    await flush();
    expect(run).toHaveBeenCalledWith('work');
    expect(byTestId('mcp-health-result')?.dataset.success).toBe('true');
    expect(byTestId('mcp-health-result')?.textContent).toContain('42 ms');
    expect(byTestId('mcp-health-result-tools')?.textContent).toBe(
      '2 tools: search, fetch',
    );
    expect(onTested).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate submissions while a test runs', async () => {
    const pending = deferred<McpTestConnectionOutcome>();
    const run = jest.fn(() => pending.promise);
    renderHealth({ testConnection: { available: true, run } });
    click('mcp-health-test');
    click('mcp-health-test');
    expect(run).toHaveBeenCalledTimes(1);
    expect(byTestId('mcp-health-test')?.hasAttribute('disabled')).toBe(true);
    pending.resolve({ success: false, message: 'Nope', error: 'refused' });
    await flush();
    expect(byTestId('mcp-health-result')?.dataset.success).toBe('false');
    expect(byTestId('mcp-health-result-error')?.textContent).toBe('refused');
  });

  it('reports a thrown test as a failure', async () => {
    renderHealth({
      testConnection: {
        available: true,
        run: () => Promise.reject(new Error('Desktop offline')),
      },
    });
    click('mcp-health-test');
    await flush();
    expect(byTestId('mcp-health-result-error')?.textContent).toBe(
      'Desktop offline',
    );
  });

  it('drops a late result after the target changes', async () => {
    const pending = deferred<McpTestConnectionOutcome>();
    renderHealth({
      testConnection: { available: true, run: () => pending.promise },
    });
    click('mcp-health-test');
    renderHealth({
      targetKey: 'server-2',
      testConnection: { available: true, run: () => pending.promise },
    });
    pending.resolve({ success: true, message: 'OK' });
    await flush();
    expect(byTestId('mcp-health-result')).toBeNull();
  });

  it('repairs a selection the configuration list no longer offers', () => {
    renderHealth({
      testConnection: { available: true, run: jest.fn() },
      testableConfigIds: ['work'],
    });
    expect(byTestId('mcp-health-config-select')).toBeNull();
    expect(byTestId('mcp-health-test')?.hasAttribute('disabled')).toBe(false);
  });

  it('explains an unavailable test and an empty configuration list', () => {
    renderHealth({
      testConnection: { available: false, reason: 'Desktop is offline.' },
    });
    const button = byTestId('mcp-health-test');
    expect(button?.hasAttribute('disabled')).toBe(true);
    const reason = byTestId('mcp-health-test-reason');
    expect(reason?.textContent).toBe('Desktop is offline.');
    expect(button?.getAttribute('aria-describedby')).toBe(reason?.id);

    renderHealth({
      testConnection: { available: true, run: jest.fn() },
      testableConfigIds: [],
    });
    expect(byTestId('mcp-health-test-reason')?.textContent).toBe(
      'Add a configuration before testing this server.',
    );
  });
});

function renderActions(
  props: Partial<McpServerManagementActionsProps> = {},
): void {
  act(() =>
    root.render(
      <McpServerManagementActions
        targetKey="server-1"
        serverName="Acme"
        placement="device"
        {...props}
      />,
    ),
  );
}

describe('McpServerManagementActions', () => {
  it('omits inapplicable actions and explains unavailable ones', () => {
    renderActions({
      moveToCloud: {
        available: false,
        reason: 'Available in the desktop app.',
      },
    });
    expect(byTestId('mcp-management-placement')?.textContent).toBe(
      'This device',
    );
    expect(byTestId('mcp-management-move-device')).toBeNull();
    expect(byTestId('mcp-management-delete')).toBeNull();
    expect(
      byTestId('mcp-management-move-cloud')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(byTestId('mcp-management-move-cloud-reason')?.textContent).toBe(
      'Available in the desktop app.',
    );
  });

  it('cancels deletion without running it', () => {
    const run = jest.fn(() => Promise.resolve(undefined));
    renderActions({ deleteServer: { available: true, run } });
    click('mcp-management-delete');
    expect(document.body.textContent).toContain('Delete Acme?');
    expect(document.body.textContent).toContain('from this device');
    click('mcp-management-delete-cancel');
    expect(run).not.toHaveBeenCalled();
    expect(byTestId('mcp-management-delete-confirm')).toBeNull();
  });

  it('deletes once after confirmation and reports completion once', async () => {
    const pending = deferred<undefined>();
    const run = jest.fn(() => pending.promise);
    const onDeleted = jest.fn();
    renderActions({ deleteServer: { available: true, run }, onDeleted });
    click('mcp-management-delete');
    click('mcp-management-delete-confirm');
    click('mcp-management-delete-confirm');
    expect(run).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    await flush();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(byTestId('mcp-management-delete-confirm')).toBeNull();
  });

  it('keeps the dialog open with a recoverable error on failure', async () => {
    const onDeleted = jest.fn();
    renderActions({
      deleteServer: {
        available: true,
        run: () => Promise.reject(new Error('Refresh before trying again.')),
      },
      onDeleted,
    });
    click('mcp-management-delete');
    click('mcp-management-delete-confirm');
    await flush();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Refresh before trying again.');
    expect(byTestId('mcp-management-delete-confirm')).not.toBeNull();
  });

  it('rechecks availability when the confirmation is submitted', async () => {
    const run = jest.fn(() => Promise.resolve(undefined));
    renderActions({ deleteServer: { available: true, run } });
    click('mcp-management-delete');
    renderActions({
      deleteServer: {
        available: false,
        reason: 'Reconnect your desktop to manage this server.',
      },
    });
    click('mcp-management-delete-confirm');
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Reconnect your desktop to manage this server.',
    );
  });

  it('disables every action while other work runs', () => {
    renderActions({
      busy: true,
      deleteServer: { available: true, run: jest.fn() },
    });
    expect(byTestId('mcp-management-delete')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows a failed move inline', async () => {
    renderActions({
      moveToDevice: {
        available: true,
        run: () => Promise.reject(new Error('Move failed.')),
      },
    });
    click('mcp-management-move-device');
    await flush();
    expect(byTestId('mcp-management-error')?.textContent).toBe('Move failed.');
  });
});

describe('management target and configuration races (CAN-4265 audit)', () => {
  it('does not transfer an open delete confirmation to another server', () => {
    const run = jest.fn();
    renderActions({ deleteServer: { available: true, run } });
    click('mcp-management-delete');
    renderActions({
      targetKey: 'server-2',
      serverName: 'Other',
      deleteServer: { available: true, run },
    });
    expect(byTestId('mcp-management-delete-confirm')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
  it('rechecks conflicting work when submitting an open confirmation', async () => {
    const run = jest.fn();
    renderActions({ deleteServer: { available: true, run } });
    click('mcp-management-delete');
    renderActions({ busy: true, deleteServer: { available: true, run } });
    click('mcp-management-delete-confirm');
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
  it('ignores delete completion after navigating to another server', async () => {
    const pending = deferred<void>();
    const onDeleted = jest.fn();
    renderActions({
      deleteServer: { available: true, run: () => pending.promise },
      onDeleted,
    });
    click('mcp-management-delete');
    click('mcp-management-delete-confirm');
    renderActions({ targetKey: 'server-2', onDeleted });
    pending.resolve();
    await flush();
    expect(onDeleted).not.toHaveBeenCalled();
  });
  it('forgets a result when a configuration is removed and restored', async () => {
    const run = jest.fn(() =>
      Promise.resolve({ success: true, message: 'OK' }),
    );
    renderHealth({ testConnection: { available: true, run } });
    click('mcp-health-test');
    await flush();
    renderHealth({
      configs: [CONFIGS[1]],
      testConnection: { available: true, run },
    });
    renderHealth({ testConnection: { available: true, run } });
    expect(byTestId('mcp-health-result')).toBeNull();
  });
  it('ignores a late test after its configuration disappears', async () => {
    const pending = deferred<McpTestConnectionOutcome>();
    const onTested = jest.fn();
    renderHealth({
      testConnection: { available: true, run: () => pending.promise },
      onTested,
    });
    click('mcp-health-test');
    renderHealth({
      configs: [CONFIGS[1]],
      testConnection: { available: true, run: () => pending.promise },
      onTested,
    });
    pending.resolve({ success: true, message: 'OK' });
    await flush();
    expect(onTested).not.toHaveBeenCalled();
    expect(byTestId('mcp-health-result')).toBeNull();
  });
});

it('focuses Cancel and dismisses a deletion confirmation with Escape (CAN-4265)', async () => {
  const run = jest.fn(() => Promise.resolve());
  renderActions({ deleteServer: { available: true, run } });
  click('mcp-management-delete');
  await flush();
  expect(document.activeElement).toBe(byTestId('mcp-management-delete-cancel'));
  act((): void => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(byTestId('mcp-management-delete-confirm')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it('names the device-only deletion scope for a cloud-linked copy (CAN-4265)', () => {
  renderActions({
    placement: 'cloud',
    deleteScope: 'device-retaining-cloud',
    deleteServer: { available: true, run: jest.fn() },
  });
  click('mcp-management-delete');
  expect(document.body.textContent).toContain(
    'It stays in your cloud account.',
  );
});
