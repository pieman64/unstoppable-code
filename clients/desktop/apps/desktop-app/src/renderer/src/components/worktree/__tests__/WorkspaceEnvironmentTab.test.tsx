/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  EnvironmentConfigData,
  LoadEnvironmentConfigResponse,
  SaveEnvironmentConfigResponse,
} from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';

import { WorkspaceEnvironmentTab } from '../WorkspaceEnvironmentTab';
import { useEnvironmentsStore } from '@/stores/environmentsStore';
import {
  chooseSettingsOptionSync,
  settingsSelectOptionLabels,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

interface TestApi {
  loadEnvironmentConfig: jest.Mock<Promise<LoadEnvironmentConfigResponse>, []>;
  saveEnvironmentConfig: jest.Mock<
    Promise<SaveEnvironmentConfigResponse>,
    [EnvironmentConfigData]
  >;
}

function installApi(initial: EnvironmentConfigData): TestApi {
  const api: TestApi = {
    loadEnvironmentConfig: jest.fn(() =>
      Promise.resolve({ data: initial, encryptionAvailable: true }),
    ),
    saveEnvironmentConfig: jest.fn((data: EnvironmentConfigData) =>
      Promise.resolve({ ok: true as const, data, encryptionAvailable: true }),
    ),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function render(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

/** Chooses `value` in a runtime dropdown (the shared settings dropdown). */
function chooseRuntime(select: HTMLElement, value: string): void {
  if (!(select instanceof HTMLButtonElement)) {
    throw new Error('Not a runtime select');
  }
  chooseSettingsOptionSync(select, value);
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function resetStore(): void {
  useEnvironmentsStore.setState({
    data: null,
    encryptionAvailable: true,
    status: 'idle',
    error: null,
    secureStorageFailure: null,
    storageFailureAction: null,
    pendingSave: null,
    selectedEnvironmentId: null,
    loadVersion: 0,
    requestVersion: 0,
    dataVersion: 0,
    environmentSaveVersion: 0,
    lastSavedEnvironmentData: null,
    environmentBaseline: null,
  });
}

describe('WorkspaceEnvironmentTab', () => {
  beforeEach(() => {
    resetStore();
  });

  it('retries a failed preliminary read without saving the assignment draft', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    try {
      await flushPromises();
      const select = container.querySelector<HTMLElement>(
        '[data-testid="workspace-environment-agent"]',
      );
      if (!select) throw new Error('Assignment selector missing');
      if (!select) throw new Error('Assignment selector missing');
      chooseRuntime(select, 'default-overall');
      api.loadEnvironmentConfig.mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_PROBE_FAILED',
          operation: 'probe',
          state: 'unknown',
          backend: null,
          retryable: true,
        },
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="workspace-environment-save"]',
          )
          ?.click(),
      );
      await flushPromises();
      expect(useEnvironmentsStore.getState().pendingSave).toBeNull();
      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="secure-storage-retry"]',
      );
      if (!retry) throw new Error('Retry missing');
      act(() => retry.click());
      await flushPromises();
      expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(3);
      expect(api.saveEnvironmentConfig).not.toHaveBeenCalled();
      expect(select.getAttribute('data-value')).toBe('default-overall');
      expect(
        container.querySelector('[data-testid="secure-storage-notice"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="workspace-environment-saved"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="workspace-environment-error"]'),
      ).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="workspace-environment-save"]',
        )?.disabled,
      ).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('offers a Manage Environments action at the bottom of the panel', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);
    const onManageEnvironments = jest.fn();

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={onManageEnvironments}
      />,
    );
    await flushPromises();

    const manageButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-environment-manage"]',
    );
    expect(manageButton?.textContent).toBe('Manage environments');
    act(() => manageButton?.click());
    expect(onManageEnvironments).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  it.each([null, 'default-overall'])(
    'replays the pending environment save without submitting workspace override %j',
    async (override) => {
      const initial = createDefaultEnvironmentConfig(
        '2026-01-01T00:00:00.000Z',
      );
      const submitted: EnvironmentConfigData = {
        ...initial,
        environments: initial.environments.map((environment) => ({
          ...environment,
          variables: [{ key: 'RETAINED_VALUE', value: 'failed-page-payload' }],
        })),
      };
      const api = installApi(initial);
      api.saveEnvironmentConfig.mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_ENCRYPT_FAILED',
          operation: 'write',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      });
      const { container, root } = render(
        <WorkspaceEnvironmentTab
          workspaceId="ws-1"
          workspaceName="Workspace 1"
          onManageEnvironments={() => undefined}
        />,
      );
      try {
        await flushPromises();
        await act(async () => {
          await expect(
            useEnvironmentsStore.getState().save(submitted),
          ).rejects.toThrow('Storage failed.');
        });
        expect(useEnvironmentsStore.getState().pendingSave).toMatchObject({
          kind: 'environment',
          data: submitted,
        });
        const select = container.querySelector<HTMLElement>(
          '[data-testid="workspace-environment-agent"]',
        );
        if (!select) throw new Error('Assignment selector missing');
        if (override) {
          if (!select) throw new Error('Assignment selector missing');
          chooseRuntime(select, override);
        }
        const retry = container.querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        );
        if (!retry) throw new Error('Retry missing');
        act(() => retry.click());
        await flushPromises();
        expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
        expect(api.saveEnvironmentConfig.mock.calls[1][0]).toEqual(submitted);
        expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(1);
        expect(useEnvironmentsStore.getState()).toMatchObject({
          pendingSave: null,
          lastSavedEnvironmentData: submitted,
          environmentSaveVersion: 1,
        });
        expect(
          useEnvironmentsStore.getState().data?.workspaceAssignments,
        ).toEqual(initial.workspaceAssignments);
        expect(select.getAttribute('data-value')).toBe(
          override ?? '__fallback__',
        );
        expect(
          container.querySelector<HTMLButtonElement>(
            '[data-testid="workspace-environment-save"]',
          )?.disabled,
        ).toBe(!override);
        expect(
          container.querySelector(
            '[data-testid="workspace-environment-saved"]',
          ),
        ).toBeNull();
        if (override) {
          // Only the separate explicit assignment Save may submit this draft.
          api.loadEnvironmentConfig.mockResolvedValue({
            data: submitted,
            encryptionAvailable: true,
          });
          act(() =>
            container
              .querySelector<HTMLButtonElement>(
                '[data-testid="workspace-environment-save"]',
              )
              ?.click(),
          );
          await flushPromises();
          expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(3);
          expect(api.saveEnvironmentConfig.mock.calls[2][0]).toMatchObject({
            environments: submitted.environments,
            workspaceAssignments: [
              { workspaceId: 'ws-1', runtimes: { agent: override } },
            ],
          });
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('retries the failed assignment while keeping a newer local override dirty', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    api.saveEnvironmentConfig.mockResolvedValueOnce({
      ok: false,
      error: 'Storage failed.',
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();
    const select = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!select) throw new Error('Assignment selector missing');
    chooseRuntime(select, 'default-overall');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-environment-save"]',
        )
        ?.click(),
    );
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    if (!select) throw new Error('Assignment selector missing');
    chooseRuntime(select, 'default-canopy');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        )
        ?.click(),
    );
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(api.saveEnvironmentConfig.mock.calls[1][0]).toEqual(
      api.saveEnvironmentConfig.mock.calls[0][0],
    );
    expect(select?.getAttribute('data-value')).toBe('default-canopy');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-environment-save"]',
      )?.disabled,
    ).toBe(false);
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a newer workspace override dirty when it changes during an explicit save', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    let resolveSave: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();
    const select = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!select) throw new Error('Assignment selector missing');
    chooseRuntime(select, 'default-overall');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-environment-save"]',
        )
        ?.click(),
    );
    await flushPromises();
    const submitted = api.saveEnvironmentConfig.mock.calls[0][0];
    if (!select) throw new Error('Assignment selector missing');
    chooseRuntime(select, 'default-canopy');
    await act(async () => {
      resolveSave({ ok: true, data: submitted, encryptionAvailable: true });
      await Promise.resolve();
    });
    await flushPromises();
    expect(select?.getAttribute('data-value')).toBe('default-canopy');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-environment-save"]',
      )?.disabled,
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="workspace-environment-saved"]'),
    ).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('renders three runtime selectors with a global default fallback option', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    const canopy = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-canopy"]',
    );
    const agent = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    const pipeline = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-pipeline"]',
    );
    expect(canopy).not.toBeNull();
    expect(agent).not.toBeNull();
    expect(pipeline).not.toBeNull();
    if (!(canopy instanceof HTMLButtonElement)) throw new Error('No dropdown');
    expect(settingsSelectOptionLabels(canopy)[0]).toContain('Global default');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('uses cowork-specific Canopy Runtime copy without scripts or hooks', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="cowork-1"
        workspaceName="Research"
        workspaceKind="cowork"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    expect(container.textContent).toContain('terminals');
    expect(container.textContent).not.toContain('Project scripts');
    expect(container.textContent).not.toContain('hooks');

    act(() => root.unmount());
    container.remove();
  });

  it('saves the project assignment when a runtime override is selected', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    const agentSelect = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    expect(agentSelect).not.toBeNull();

    if (!agentSelect) throw new Error('Assignment selector missing');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();

    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-environment-save"]',
    );
    expect(saveButton?.disabled).toBe(false);

    act(() => {
      saveButton?.click();
    });
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    const payload = api.saveEnvironmentConfig.mock.calls[0][0];
    expect(
      payload.workspaceAssignments.find((entry) => entry.workspaceId === 'ws-1')
        ?.runtimes,
    ).toEqual({ agent: 'default-overall' });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('on a settings page, saves a runtime choice as it is made', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    const states: string[] = [];

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
        onSaveStateChange={(state) => states.push(state)}
      />,
    );
    await flushPromises();
    expect(
      container.querySelector('[data-testid="workspace-environment-save"]'),
    ).toBeNull();

    const agentSelect = container.querySelector(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!(agentSelect instanceof HTMLElement))
      throw new Error('Missing agent runtime select');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    expect(
      api.saveEnvironmentConfig.mock.calls[0][0].workspaceAssignments.find(
        (entry) => entry.workspaceId === 'ws-1',
      )?.runtimes,
    ).toEqual({ agent: 'default-overall' });
    expect(states).toContain('saving');
    expect(states[states.length - 1]).toBe('saved');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('on a settings page, writes a choice made during a save after the page moves on', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    let finishFirst: () => void = () => undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      (data: EnvironmentConfigData) =>
        new Promise((resolve) => {
          finishFirst = (): void =>
            resolve({ ok: true as const, data, encryptionAvailable: true });
        }),
    );
    const states: string[] = [];

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
        onSaveStateChange={(state) => states.push(state)}
      />,
    );
    await flushPromises();
    const choose = (runtime: string): void => {
      const select = container.querySelector(
        `[data-testid="workspace-environment-${runtime}"]`,
      );
      if (!(select instanceof HTMLElement))
        throw new Error(`Missing ${runtime} runtime select`);
      chooseRuntime(select, 'default-overall');
    };
    choose('agent');
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    // A second choice while the first save runs, then the page moves on.
    choose('pipeline');
    act(() => {
      root.unmount();
    });
    container.remove();

    await act(async () => {
      finishFirst();
      await Promise.resolve();
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(
      api.saveEnvironmentConfig.mock.calls[1][0].workspaceAssignments.find(
        (entry) => entry.workspaceId === 'ws-1',
      )?.runtimes,
    ).toEqual(expect.objectContaining({ pipeline: 'default-overall' }));
    expect(states[states.length - 1]).toBe('saved');
  });

  it('with a Save button, does not write a choice made during a save after leaving', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    let finishFirst: () => void = () => undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      (data: EnvironmentConfigData) =>
        new Promise((resolve) => {
          finishFirst = (): void =>
            resolve({ ok: true as const, data, encryptionAvailable: true });
        }),
    );
    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();
    const choose = (runtime: string): void => {
      const select = container.querySelector(
        `[data-testid="workspace-environment-${runtime}"]`,
      );
      if (!(select instanceof HTMLElement))
        throw new Error(`Missing ${runtime} runtime select`);
      chooseRuntime(select, 'default-overall');
    };
    choose('agent');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-environment-save"]',
        )
        ?.click(),
    );
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    // A second choice while that save runs, then the panel closes without
    // Save being pressed again.
    choose('pipeline');
    act(() => {
      root.unmount();
    });
    container.remove();

    await act(async () => {
      finishFirst();
      await Promise.resolve();
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
  });

  it('on a settings page, lets the page wait for a running save and hear that it failed', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    let failSave: (cause: Error) => void = () => undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failSave = reject;
        }),
    );
    const registered: { flush: (() => Promise<boolean>) | null } = {
      flush: null,
    };

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
        onRegisterFlush={(next) => {
          registered.flush = next;
        }}
      />,
    );
    await flushPromises();
    const agentSelect = container.querySelector(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!(agentSelect instanceof HTMLElement))
      throw new Error('Missing agent runtime select');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);

    let result: boolean | undefined;
    const waiting = registered.flush?.().then((saved) => {
      result = saved;
    });
    await flushPromises();
    expect(result).toBeUndefined();
    await act(async () => {
      failSave(new Error('Disk is full'));
      await waiting;
    });
    expect(result).toBe(false);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('on a settings page, writes a choice made during a save before the page may close', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    let finishFirst: () => void = () => undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      (data: EnvironmentConfigData) =>
        new Promise((resolve) => {
          finishFirst = (): void =>
            resolve({ ok: true as const, data, encryptionAvailable: true });
        }),
    );
    const registered: { flush: (() => Promise<boolean>) | null } = {
      flush: null,
    };

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
        onRegisterFlush={(next) => {
          registered.flush = next;
        }}
      />,
    );
    await flushPromises();
    const choose = (runtime: string): void => {
      const select = container.querySelector(
        `[data-testid="workspace-environment-${runtime}"]`,
      );
      if (!(select instanceof HTMLElement))
        throw new Error(`Missing ${runtime} runtime select`);
      chooseRuntime(select, 'default-overall');
    };
    choose('agent');
    await flushPromises();
    choose('pipeline');

    let result: boolean | undefined;
    let waiting: Promise<void> | undefined;
    act(() => {
      // The page closes as soon as the flush says everything is saved.
      waiting = registered.flush?.().then((saved) => {
        result = saved;
        root.unmount();
      });
    });
    await act(async () => {
      finishFirst();
      await waiting;
    });

    expect(result).toBe(true);
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(
      api.saveEnvironmentConfig.mock.calls[1][0].workspaceAssignments.find(
        (entry) => entry.workspaceId === 'ws-1',
      )?.runtimes,
    ).toEqual(expect.objectContaining({ pipeline: 'default-overall' }));

    container.remove();
  });

  it('on a settings page, holds a choice while a failed environment save waits for Retry', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    const unsaved: boolean[] = [];

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
        onUnsavedChange={(next) => unsaved.push(next)}
      />,
    );
    await flushPromises();
    act(() => {
      useEnvironmentsStore.setState({
        pendingSave: {
          kind: 'environment',
          data: initial,
          dataVersion: 0,
          preserveLocal: false,
        },
      });
    });

    const agentSelect = container.querySelector(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!(agentSelect instanceof HTMLElement))
      throw new Error('Missing agent runtime select');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();
    expect(api.saveEnvironmentConfig).not.toHaveBeenCalled();
    // The page hears that a choice waits, so it can keep itself open.
    expect(unsaved[unsaved.length - 1]).toBe(true);

    // Once the waiting save settles, the choice is written.
    act(() => {
      useEnvironmentsStore.setState({ pendingSave: null });
    });
    await flushPromises();
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    expect(unsaved[unsaved.length - 1]).toBe(false);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('saves project assignments against persisted config instead of local drafts', async () => {
    const persisted = createDefaultEnvironmentConfig(
      '2026-01-01T00:00:00.000Z',
    );
    const draft = {
      ...persisted,
      environments: [
        ...persisted.environments,
        {
          id: 'draft-env',
          name: 'Draft',
          parentId: null,
          isDefault: false,
          uiMode: 'key-value' as const,
          variables: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const api = installApi(persisted);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    act(() => {
      useEnvironmentsStore.getState().setLocal(draft);
    });

    const agentSelect = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!agentSelect) throw new Error('Assignment selector missing');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();

    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-environment-save"]',
    );
    act(() => {
      saveButton?.click();
    });
    await flushPromises();

    const payload = api.saveEnvironmentConfig.mock.calls[0][0];
    expect(
      payload.environments.some(
        (environment) => environment.id === 'draft-env',
      ),
    ).toBe(false);
    expect(
      payload.workspaceAssignments.find((entry) => entry.workspaceId === 'ws-1')
        ?.runtimes,
    ).toEqual({ agent: 'default-overall' });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('resets pending overrides when switching between unassigned projects', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    const agentSelect = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!agentSelect) throw new Error('Assignment selector missing');
    chooseRuntime(agentSelect, 'default-overall');
    await flushPromises();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-environment-save"]',
      )?.disabled,
    ).toBe(false);

    act(() => {
      root.render(
        <WorkspaceEnvironmentTab
          workspaceId="ws-2"
          workspaceName="Workspace 2"
          onManageEnvironments={() => undefined}
        />,
      );
    });
    await flushPromises();

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-environment-save"]',
      )?.disabled,
    ).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows a retry path when environment assignments fail to load', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api: TestApi = {
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockRejectedValueOnce(new Error('load failed'))
        .mockResolvedValue({ data: initial, encryptionAvailable: true }),
      saveEnvironmentConfig: jest.fn((data: EnvironmentConfigData) =>
        Promise.resolve({ ok: true as const, data, encryptionAvailable: true }),
      ),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    expect(
      container.querySelector('[data-testid="workspace-environment-error"]'),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-environment-retry"]',
        )
        ?.click();
    });
    await flushPromises();

    expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="workspace-environment-agent"]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('removes a project assignment entry when all runtimes are cleared back to global', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.workspaceAssignments.push({
      workspaceId: 'ws-1',
      runtimes: { agent: 'default-overall' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const api = installApi(initial);

    const { container, root } = render(
      <WorkspaceEnvironmentTab
        workspaceId="ws-1"
        workspaceName="Workspace 1"
        onManageEnvironments={() => undefined}
      />,
    );
    await flushPromises();

    const agentSelect = container.querySelector<HTMLElement>(
      '[data-testid="workspace-environment-agent"]',
    );
    if (!agentSelect) throw new Error('Assignment selector missing');
    chooseRuntime(agentSelect, '__fallback__');
    await flushPromises();

    const saveButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-environment-save"]',
    );
    act(() => {
      saveButton?.click();
    });
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    const payload = api.saveEnvironmentConfig.mock.calls[0][0];
    expect(
      payload.workspaceAssignments.some(
        (entry) => entry.workspaceId === 'ws-1',
      ),
    ).toBe(false);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
