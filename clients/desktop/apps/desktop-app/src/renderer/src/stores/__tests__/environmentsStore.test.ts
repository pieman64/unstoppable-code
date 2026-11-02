/**
 * @jest-environment jsdom
 */
import type {
  EnvironmentConfigData,
  LoadEnvironmentConfigResponse,
  SaveEnvironmentConfigResponse,
  SecureStorageFailure,
} from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvironmentVariableEditor } from '../../components/environments/EnvironmentVariableEditor';
import {
  environmentEditorBaseline,
  useEnvironmentsStore,
} from '../environmentsStore';

interface TestApi {
  loadEnvironmentConfig: jest.Mock<Promise<LoadEnvironmentConfigResponse>, []>;
  saveEnvironmentConfig: jest.Mock<
    Promise<SaveEnvironmentConfigResponse>,
    [EnvironmentConfigData]
  >;
}

function installApi(api: TestApi): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
}

function mockSaveEnvironmentConfig(
  implementation: () => Promise<SaveEnvironmentConfigResponse>,
): TestApi['saveEnvironmentConfig'] {
  return jest.fn<
    Promise<SaveEnvironmentConfigResponse>,
    [EnvironmentConfigData]
  >(implementation);
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
    environmentBaseline: null,
    lastSavedEnvironmentData: null,
  });
}

describe('environmentsStore', () => {
  beforeEach(() => {
    resetStore();
  });

  it('preserves an existing draft when an environment read returns a storage failure', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValue({
          ok: false,
          error: 'Cannot read storage.',
          secureStorageFailure: failure,
        }),
      saveEnvironmentConfig: jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >(),
    });
    useEnvironmentsStore.setState({
      data: config,
      status: 'ready',
      loadVersion: 4,
    });
    await useEnvironmentsStore.getState().load();
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: config,
      status: 'error',
      loadVersion: 4,
      secureStorageFailure: failure,
    });
  });

  it('clears stale storage failure after a later generic transport error', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockRejectedValue(new Error('Transport failed.')),
      saveEnvironmentConfig: jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockRejectedValue(new Error('Transport failed.')),
    });
    const failure = {
      version: 1 as const,
      code: 'SECURE_STORAGE_PROBE_FAILED' as const,
      operation: 'probe' as const,
      state: 'unknown' as const,
      backend: null,
      retryable: true,
    };
    useEnvironmentsStore.setState({
      data: config,
      secureStorageFailure: failure,
      storageFailureAction: 'save',
    });
    await expect(useEnvironmentsStore.getState().save(config)).rejects.toThrow(
      'Transport failed.',
    );
    expect(useEnvironmentsStore.getState().secureStorageFailure).toBeNull();
    useEnvironmentsStore.setState({
      secureStorageFailure: failure,
      storageFailureAction: 'load',
    });
    await useEnvironmentsStore.getState().load();
    expect(useEnvironmentsStore.getState().secureStorageFailure).toBeNull();
  });

  it('surfaces structured save errors without dereferencing response data', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    installApi({
      loadEnvironmentConfig: jest.fn(() =>
        Promise.resolve({ data: config, encryptionAvailable: true }),
      ),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(() =>
        Promise.resolve({ ok: false, error: 'Inheritance cycle detected.' }),
      ),
    });
    useEnvironmentsStore.setState({
      data: config,
      status: 'ready',
      selectedEnvironmentId: 'default-overall',
    });

    await expect(useEnvironmentsStore.getState().save(config)).rejects.toThrow(
      'Inheritance cycle detected.',
    );

    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: config,
      status: 'error',
      error: 'Inheritance cycle detected.',
      selectedEnvironmentId: 'default-overall',
    });
  });

  it('retains typed storage failure and the environment draft until a successful retry', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const failure = {
      version: 1 as const,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED' as const,
      operation: 'write' as const,
      state: 'locked' as const,
      backend: null,
      retryable: true,
    };
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: config,
        encryptionAvailable: true,
      });
    installApi({
      loadEnvironmentConfig: jest.fn(() =>
        Promise.resolve({ data: config, encryptionAvailable: true }),
      ),
      saveEnvironmentConfig,
    });
    useEnvironmentsStore.setState({ data: config, status: 'ready' });
    await expect(
      useEnvironmentsStore.getState().save(config),
    ).rejects.toThrow();
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: config,
      status: 'error',
      secureStorageFailure: failure,
    });
    await useEnvironmentsStore.getState().save(config);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      status: 'ready',
      secureStorageFailure: null,
    });
  });

  it('does not advance the load version after a save', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const savedConfig: EnvironmentConfigData = {
      ...config,
      environments: config.environments.map((environment) =>
        environment.id === 'default-overall'
          ? { ...environment, variables: [{ key: 'SAVED', value: '1' }] }
          : environment,
      ),
    };
    installApi({
      loadEnvironmentConfig: jest.fn(() =>
        Promise.resolve({ data: config, encryptionAvailable: true }),
      ),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(() =>
        Promise.resolve({
          ok: true,
          data: savedConfig,
          encryptionAvailable: true,
        }),
      ),
    });
    useEnvironmentsStore.setState({
      data: config,
      status: 'ready',
      selectedEnvironmentId: 'default-overall',
      loadVersion: 4,
    });

    await useEnvironmentsStore.getState().save(savedConfig);

    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: savedConfig,
      status: 'ready',
      error: null,
      secureStorageFailure: null,
      storageFailureAction: null,
      selectedEnvironmentId: 'default-overall',
      loadVersion: 4,
    });
  });

  it('tracks environment edits after an assignment save first populates the unloaded store', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const assigned: EnvironmentConfigData = {
      ...config,
      workspaceAssignments: [
        {
          workspaceId: 'app-advisor',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    installApi({
      loadEnvironmentConfig: jest.fn(() =>
        Promise.resolve({ data: config, encryptionAvailable: true }),
      ),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(() =>
        Promise.resolve({
          ok: true,
          data: assigned,
          encryptionAvailable: true,
        }),
      ),
    });
    expect(useEnvironmentsStore.getState().data).toBeNull();

    await useEnvironmentsStore.getState().saveWorkspaceAssignments(assigned);

    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: assigned,
      status: 'ready',
      environmentSaveVersion: 0,
      lastSavedEnvironmentData: null,
      environmentBaseline: environmentEditorBaseline(assigned),
    });
    const edited: EnvironmentConfigData = {
      ...assigned,
      environments: assigned.environments.map((environment) =>
        environment.id === 'default-overall'
          ? {
              ...environment,
              variables: [{ key: 'EXAMPLE', value: 'edited' }],
            }
          : environment,
      ),
    };
    useEnvironmentsStore.getState().setLocal(edited);

    const state = useEnvironmentsStore.getState();
    expect(state.environmentBaseline).not.toBeNull();
    expect(environmentEditorBaseline(edited)).not.toBe(
      state.environmentBaseline,
    );
    expect(state.data?.workspaceAssignments).toEqual(
      assigned.workspaceAssignments,
    );
  });

  it('merges project assignment saves without replacing local drafts', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const draft: EnvironmentConfigData = {
      ...config,
      environments: [
        ...config.environments,
        {
          id: 'draft-env',
          name: 'Draft',
          parentId: null,
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: '2026-05-29T00:00:00.000Z',
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const savedConfig: EnvironmentConfigData = {
      ...config,
      workspaceAssignments: [
        {
          workspaceId: 'workspace-1',
          runtimes: { agent: 'default-overall' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    installApi({
      loadEnvironmentConfig: jest.fn(() =>
        Promise.resolve({ data: config, encryptionAvailable: true }),
      ),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(() =>
        Promise.resolve({
          ok: true,
          data: savedConfig,
          encryptionAvailable: true,
        }),
      ),
    });
    useEnvironmentsStore.setState({
      data: draft,
      status: 'ready',
      selectedEnvironmentId: 'draft-env',
    });

    await useEnvironmentsStore.getState().saveWorkspaceAssignments(savedConfig);

    const currentData = useEnvironmentsStore.getState().data;
    expect(
      currentData?.environments.some(
        (environment) => environment.id === 'draft-env',
      ),
    ).toBe(true);
    expect(currentData?.workspaceAssignments).toEqual(
      savedConfig.workspaceAssignments,
    );
    expect(useEnvironmentsStore.getState()).toMatchObject({
      status: 'ready',
      error: null,
      selectedEnvironmentId: 'draft-env',
      environmentBaseline: environmentEditorBaseline(savedConfig),
    });
    expect(environmentEditorBaseline(draft)).not.toBe(
      useEnvironmentsStore.getState().environmentBaseline,
    );
  });

  it('retries the exact failed environment save instead of a later local draft', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const submitted = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'default-agent' },
    };
    const laterDraft = {
      ...config,
      environments: [
        ...config.environments,
        { ...config.environments[0], id: 'unsubmitted', name: 'Unsubmitted' },
      ],
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: submitted,
        encryptionAvailable: true,
      });
    installApi({
      loadEnvironmentConfig: jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(),
      saveEnvironmentConfig,
    });

    await expect(
      useEnvironmentsStore.getState().save(submitted),
    ).rejects.toThrow('Storage failed.');
    useEnvironmentsStore.getState().setLocal(laterDraft);
    await useEnvironmentsStore.getState().retryStorageFailure();

    expect(saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(saveEnvironmentConfig.mock.calls[1][0]).toEqual(submitted);
    expect(useEnvironmentsStore.getState().data).toEqual(laterDraft);
    expect(useEnvironmentsStore.getState().secureStorageFailure).toBeNull();
  });

  it.each(['generic failure', 'rejected promise'] as const)(
    'retains environment payload A and draft B after a retry has a %s',
    async (retryFailure) => {
      const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const submitted: EnvironmentConfigData = {
        ...config,
        environments: config.environments.map((environment) => ({
          ...environment,
          variables: [{ key: 'DRAFT', value: 'A' }],
        })),
      };
      const laterDraft: EnvironmentConfigData = {
        ...submitted,
        environments: submitted.environments.map((environment) => ({
          ...environment,
          variables: [{ key: 'DRAFT', value: 'B' }],
        })),
      };
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      const saveEnvironmentConfig = jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockResolvedValueOnce({
          ok: false,
          error: 'Storage failed.',
          secureStorageFailure: failure,
        })
        .mockImplementationOnce(() =>
          retryFailure === 'rejected promise'
            ? Promise.reject(new Error('Retry failed.'))
            : Promise.resolve({ ok: false, error: 'Retry failed.' }),
        )
        .mockResolvedValueOnce({
          ok: true,
          data: submitted,
          encryptionAvailable: true,
        });
      const loadEnvironmentConfig = jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >();
      installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
      useEnvironmentsStore.setState({ data: config, status: 'ready' });
      await expect(
        useEnvironmentsStore.getState().save(submitted),
      ).rejects.toThrow('Storage failed.');
      useEnvironmentsStore.getState().setLocal(laterDraft);
      await expect(
        useEnvironmentsStore.getState().retryStorageFailure(),
      ).rejects.toThrow('Retry failed.');
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: laterDraft,
        pendingSave: {
          kind: 'environment',
          data: submitted,
          preserveLocal: true,
        },
      });
      await useEnvironmentsStore.getState().retryStorageFailure();
      expect(
        saveEnvironmentConfig.mock.calls.map(([payload]) => payload),
      ).toEqual([submitted, submitted, submitted]);
      expect(loadEnvironmentConfig).not.toHaveBeenCalled();
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: laterDraft,
        pendingSave: null,
        status: 'ready',
        lastSavedEnvironmentData: submitted,
      });
    },
  );

  it('retains the environment replay through another failure without adopting a newer assignment draft', async () => {
    const submitted = createDefaultEnvironmentConfig(
      '2026-05-29T00:00:00.000Z',
    );
    const laterDraft: EnvironmentConfigData = {
      ...submitted,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-overall' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Still locked.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: submitted,
        encryptionAvailable: true,
      });
    const loadEnvironmentConfig = jest.fn<
      Promise<LoadEnvironmentConfigResponse>,
      []
    >();
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    useEnvironmentsStore.setState({ data: submitted, status: 'ready' });
    await expect(
      useEnvironmentsStore.getState().save(submitted),
    ).rejects.toThrow('Storage failed.');
    useEnvironmentsStore.getState().setLocal(laterDraft);
    await expect(
      useEnvironmentsStore.getState().retryStorageFailure(),
    ).rejects.toThrow('Still locked.');
    expect(useEnvironmentsStore.getState().pendingSave).toMatchObject({
      kind: 'environment',
      data: submitted,
    });
    expect(useEnvironmentsStore.getState().data).toEqual(laterDraft);
    await useEnvironmentsStore.getState().retryStorageFailure();
    expect(
      saveEnvironmentConfig.mock.calls.map(([payload]) => payload),
    ).toEqual([submitted, submitted, submitted]);
    expect(loadEnvironmentConfig).not.toHaveBeenCalled();
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: {
        ...laterDraft,
        workspaceAssignments: submitted.workspaceAssignments,
      },
      pendingSave: null,
      environmentSaveVersion: 1,
      lastSavedEnvironmentData: submitted,
    });
  });

  it('retries a failed assignment save with its original persisted payload', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const submitted = {
      ...config,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: submitted,
        encryptionAvailable: true,
      });
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValue({ data: config, encryptionAvailable: true }),
      saveEnvironmentConfig,
    });

    await expect(
      useEnvironmentsStore.getState().saveWorkspaceAssignments(submitted),
    ).rejects.toThrow('Storage failed.');
    await useEnvironmentsStore.getState().retryStorageFailure();

    expect(saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(saveEnvironmentConfig.mock.calls[1][0]).toEqual(submitted);
    expect(useEnvironmentsStore.getState().data?.workspaceAssignments).toEqual(
      submitted.workspaceAssignments,
    );
  });

  it('ignores an old load response after a local edit or later save', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      environments: [
        { ...config.environments[0], name: 'Edited' },
        ...config.environments.slice(1),
      ],
    };
    let resolveLoad: (value: LoadEnvironmentConfigResponse) => void = () =>
      undefined;
    const loadEnvironmentConfig = jest.fn<
      Promise<LoadEnvironmentConfigResponse>,
      []
    >(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    installApi({
      loadEnvironmentConfig,
      saveEnvironmentConfig: mockSaveEnvironmentConfig(() =>
        Promise.resolve({ ok: true, data: edited, encryptionAvailable: true }),
      ),
    });
    useEnvironmentsStore.setState({ data: config, status: 'ready' });

    const pendingLoad = useEnvironmentsStore.getState().load();
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    resolveLoad({ data: config, encryptionAvailable: true });
    await pendingLoad;
    expect(useEnvironmentsStore.getState().data).toEqual(edited);

    const secondLoad = useEnvironmentsStore.getState().load();
    await Promise.resolve();
    await useEnvironmentsStore.getState().save(edited);
    resolveLoad({ data: config, encryptionAvailable: true });
    await secondLoad;
    expect(useEnvironmentsStore.getState().data).toEqual(edited);
  });

  it('settles a load after a local edit without replacing the draft', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'draft' },
    };
    let resolveLoad: (value: LoadEnvironmentConfigResponse) => void = () =>
      undefined;
    installApi({
      loadEnvironmentConfig: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          }),
      ),
      saveEnvironmentConfig: jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >(),
    });
    const pending = useEnvironmentsStore.getState().load();
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    resolveLoad({ data: config, encryptionAvailable: true });
    await pending;
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: edited,
      status: 'ready',
    });
  });

  it('reports a load failure after a local edit without losing the draft', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'draft' },
    };
    let rejectLoad: (reason: Error) => void = () => undefined;
    installApi({
      loadEnvironmentConfig: jest.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectLoad = reject;
          }),
      ),
      saveEnvironmentConfig: jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >(),
    });
    const pending = useEnvironmentsStore.getState().load();
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    rejectLoad(new Error('Transport failed.'));
    await pending;
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: edited,
      status: 'error',
      error: 'Transport failed.',
    });
  });

  it('settles a successful save after a local edit and records the exact saved baseline', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'draft' },
    };
    let resolveSave: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    installApi({
      loadEnvironmentConfig: jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    const pending = useEnvironmentsStore.getState().save(config);
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    resolveSave({ ok: true, data: config, encryptionAvailable: true });
    await pending;
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: edited,
      status: 'ready',
      lastSavedEnvironmentData: config,
      environmentSaveVersion: 1,
    });
  });

  it('reports a generic save rejection after a local edit', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'draft' },
    };
    let rejectSave: (reason: Error) => void = () => undefined;
    installApi({
      loadEnvironmentConfig: jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(
        () =>
          new Promise((_resolve, reject) => {
            rejectSave = reject;
          }),
      ),
    });
    const pending = useEnvironmentsStore.getState().save(config);
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    rejectSave(new Error('Transport failed.'));
    await expect(pending).rejects.toThrow('Transport failed.');
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: edited,
      status: 'error',
      error: 'Transport failed.',
      storageFailureAction: 'save',
    });
  });

  it('settles a failed save after a local edit and retains its exact retry payload', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const edited = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'draft' },
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    let resolveSave: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    installApi({
      loadEnvironmentConfig: jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(),
      saveEnvironmentConfig: mockSaveEnvironmentConfig(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    const pending = useEnvironmentsStore.getState().save(config);
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(edited);
    resolveSave({
      ok: false,
      error: 'Storage failed.',
      secureStorageFailure: failure,
    });
    await expect(pending).rejects.toThrow('Storage failed.');
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: edited,
      status: 'error',
      secureStorageFailure: failure,
      pendingSave: { kind: 'environment', data: config },
    });
  });

  it.each(['success', 'storage failure', 'transport failure'] as const)(
    'settles an environment save superseded by an assignment save with %s',
    async (assignmentOutcome) => {
      const submitted = createDefaultEnvironmentConfig(
        '2026-05-29T00:00:00.000Z',
      );
      const assignment: EnvironmentConfigData = {
        ...submitted,
        workspaceAssignments: [
          {
            workspaceId: 'ws-1',
            runtimes: { agent: 'default-agent' },
            updatedAt: '2026-05-29T00:00:00.000Z',
          },
        ],
      };
      const laterDraft: EnvironmentConfigData = {
        ...submitted,
        globalRuntimes: { ...submitted.globalRuntimes, agent: 'newer-draft' },
      };
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      let resolveEnvironment: (
        value: SaveEnvironmentConfigResponse,
      ) => void = () => undefined;
      let resolveAssignment: (
        value: SaveEnvironmentConfigResponse,
      ) => void = () => undefined;
      let rejectAssignment: (reason: Error) => void = () => undefined;
      let assignmentStarted: () => void = () => undefined;
      const assignmentWriteStarted = new Promise<void>((resolve) => {
        assignmentStarted = resolve;
      });
      const saveEnvironmentConfig = jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEnvironment = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveAssignment = resolve;
              rejectAssignment = reject;
              assignmentStarted();
            }),
        );
      installApi({
        loadEnvironmentConfig: jest
          .fn<Promise<LoadEnvironmentConfigResponse>, []>()
          .mockResolvedValue({ data: submitted, encryptionAvailable: true }),
        saveEnvironmentConfig,
      });
      useEnvironmentsStore.setState({
        data: submitted,
        status: 'ready',
        loadVersion: 4,
      });
      const environmentSave = useEnvironmentsStore.getState().save(submitted);
      const assignmentSave = useEnvironmentsStore
        .getState()
        .saveWorkspaceAssignments(assignment);
      // Observe rejections immediately so failed queue entries are always consumed.
      const assignmentResult = assignmentSave.then(
        () => null,
        (error: unknown) => error,
      );
      useEnvironmentsStore.getState().setLocal(laterDraft);
      await Promise.resolve();
      const callsBeforeCompletion = saveEnvironmentConfig.mock.calls.length;
      resolveEnvironment({
        ok: true,
        data: submitted,
        encryptionAvailable: false,
      });
      await environmentSave;
      const stateAfterEnvironmentSave = useEnvironmentsStore.getState();
      await assignmentWriteStarted;
      if (assignmentOutcome === 'transport failure') {
        rejectAssignment(new Error('Assignment transport failed.'));
      } else if (assignmentOutcome === 'storage failure') {
        resolveAssignment({
          ok: false,
          error: 'Assignment storage failed.',
          secureStorageFailure: failure,
        });
      } else {
        resolveAssignment({
          ok: true,
          data: assignment,
          encryptionAvailable: true,
        });
      }
      const error = await assignmentResult;

      expect(callsBeforeCompletion).toBe(1);
      expect(stateAfterEnvironmentSave).toMatchObject({
        data: laterDraft,
        status: 'saving',
        error: null,
        encryptionAvailable: true,
        loadVersion: 4,
        environmentSaveVersion: 1,
        lastSavedEnvironmentData: submitted,
      });
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data:
          assignmentOutcome === 'success'
            ? {
                ...laterDraft,
                workspaceAssignments: assignment.workspaceAssignments,
              }
            : laterDraft,
        status: assignmentOutcome === 'success' ? 'ready' : 'error',
        environmentSaveVersion: 1,
        lastSavedEnvironmentData: submitted,
        pendingSave:
          assignmentOutcome === 'storage failure'
            ? { kind: 'workspaceAssignments', data: assignment }
            : null,
      });
      if (assignmentOutcome === 'success') expect(error).toBeNull();
      else expect(error).toBeInstanceOf(Error);
    },
  );

  it.each(['storage failure', 'transport failure'] as const)(
    'does not announce an environment save with %s superseded by an assignment save',
    async (environmentOutcome) => {
      const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      const saveEnvironmentConfig = jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockImplementationOnce(() =>
          environmentOutcome === 'transport failure'
            ? Promise.reject(new Error('Environment transport failed.'))
            : Promise.resolve({
                ok: false,
                error: 'Environment storage failed.',
                secureStorageFailure: failure,
              }),
        )
        .mockResolvedValueOnce({
          ok: true,
          data: config,
          encryptionAvailable: true,
        });
      installApi({
        loadEnvironmentConfig: jest
          .fn<Promise<LoadEnvironmentConfigResponse>, []>()
          .mockResolvedValue({ data: config, encryptionAvailable: true }),
        saveEnvironmentConfig,
      });
      const environmentSave = useEnvironmentsStore.getState().save(config);
      const assignmentSave = useEnvironmentsStore
        .getState()
        .saveWorkspaceAssignments(config);
      await expect(environmentSave).rejects.toThrow();
      await assignmentSave;
      expect(useEnvironmentsStore.getState()).toMatchObject({
        status: 'ready',
        environmentSaveVersion: 0,
        lastSavedEnvironmentData: null,
        secureStorageFailure: null,
        pendingSave: null,
      });
    },
  );

  it.each(['save', 'load'] as const)(
    'retries a preliminary assignment read failure marked %s without a pending save, including repeated failure and recovery',
    async (storageFailureAction) => {
      const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      const loadEnvironmentConfig = jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValueOnce({
          ok: false,
          error: 'Still locked.',
          secureStorageFailure: failure,
        })
        .mockResolvedValueOnce({ data: config, encryptionAvailable: true });
      const saveEnvironmentConfig = jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >();
      installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
      // WorkspaceEnvironmentTab's preliminary read fails before a write is submitted.
      useEnvironmentsStore.setState({
        data: config,
        status: 'error',
        error: 'Cannot read assignments.',
        secureStorageFailure: failure,
        storageFailureAction,
        pendingSave: null,
      });
      await useEnvironmentsStore.getState().retryStorageFailure();
      expect(loadEnvironmentConfig).toHaveBeenCalledTimes(1);
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: config,
        status: 'error',
        error: 'Still locked.',
        secureStorageFailure: failure,
        storageFailureAction: 'load',
        pendingSave: null,
        loadVersion: 0,
        environmentSaveVersion: 0,
      });
      await useEnvironmentsStore.getState().retryStorageFailure();
      expect(loadEnvironmentConfig).toHaveBeenCalledTimes(2);
      expect(saveEnvironmentConfig).not.toHaveBeenCalled();
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: config,
        status: 'ready',
        secureStorageFailure: null,
        storageFailureAction: null,
        loadVersion: 1,
        environmentSaveVersion: 0,
        lastSavedEnvironmentData: null,
      });
    },
  );

  it('preserves a newer local draft when the preliminary assignment read retry completes late', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const laterDraft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'newer-draft' },
    };
    let resolveLoad: (value: LoadEnvironmentConfigResponse) => void = () =>
      undefined;
    const loadEnvironmentConfig = jest.fn<
      Promise<LoadEnvironmentConfigResponse>,
      []
    >(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const saveEnvironmentConfig = jest.fn<
      Promise<SaveEnvironmentConfigResponse>,
      [EnvironmentConfigData]
    >();
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    useEnvironmentsStore.setState({
      data: config,
      status: 'error',
      storageFailureAction: 'save',
      pendingSave: null,
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    const retry = useEnvironmentsStore.getState().retryStorageFailure();
    await Promise.resolve();
    useEnvironmentsStore.getState().setLocal(laterDraft);
    resolveLoad({ data: config, encryptionAvailable: true });
    await retry;
    expect(loadEnvironmentConfig).toHaveBeenCalledTimes(1);
    expect(saveEnvironmentConfig).not.toHaveBeenCalled();
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: laterDraft,
      status: 'ready',
      secureStorageFailure: null,
      storageFailureAction: null,
      loadVersion: 0,
      environmentSaveVersion: 0,
      lastSavedEnvironmentData: null,
    });
  });

  it('settles a durable environment save without clearing a newer read failure', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const laterDraft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'newer-draft' },
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    let resolveSave: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValue({
          ok: false,
          error: 'Newer read failed.',
          secureStorageFailure: failure,
        }),
      saveEnvironmentConfig: jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    useEnvironmentsStore.setState({ data: config, status: 'ready' });
    const save = useEnvironmentsStore.getState().save(config);
    await Promise.resolve();
    const load = useEnvironmentsStore.getState().load();
    useEnvironmentsStore.getState().setLocal(laterDraft);
    resolveSave({ ok: true, data: config, encryptionAvailable: false });
    await Promise.all([save, load]);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: laterDraft,
      status: 'error',
      error: 'Newer read failed.',
      secureStorageFailure: failure,
      storageFailureAction: 'load',
      encryptionAvailable: true,
      environmentSaveVersion: 1,
      lastSavedEnvironmentData: config,
      loadVersion: 0,
    });
  });

  it('reads persisted environment fields at queued assignment execution instead of overwriting them with an earlier snapshot', async () => {
    const original = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const environment: EnvironmentConfigData = {
      ...original,
      environments: original.environments.map((item) => ({
        ...item,
        name: `${item.name} saved`,
      })),
      globalRuntimes: { ...original.globalRuntimes, agent: 'default-overall' },
    };
    const assignment: EnvironmentConfigData = {
      ...original,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    let persisted = original;
    let resolveEnvironment: () => void = () => undefined;
    const loadEnvironmentConfig = jest.fn<
      Promise<LoadEnvironmentConfigResponse>,
      []
    >(() => Promise.resolve({ data: persisted, encryptionAvailable: true }));
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockImplementationOnce(
        (data) =>
          new Promise((resolve) => {
            resolveEnvironment = (): void => {
              persisted = data;
              resolve({ ok: true, data, encryptionAvailable: true });
            };
          }),
      )
      .mockImplementationOnce((data) => {
        persisted = data;
        return Promise.resolve({ ok: true, data, encryptionAvailable: true });
      });
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    const environmentSave = useEnvironmentsStore.getState().save(environment);
    const assignmentSave = useEnvironmentsStore
      .getState()
      .saveWorkspaceAssignments(assignment);
    await Promise.resolve();
    expect(loadEnvironmentConfig).not.toHaveBeenCalled();
    expect(saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    resolveEnvironment();
    await Promise.all([environmentSave, assignmentSave]);
    expect(persisted).toEqual({
      ...environment,
      workspaceAssignments: assignment.workspaceAssignments,
    });
    expect(loadEnvironmentConfig).toHaveBeenCalledTimes(1);
    expect(saveEnvironmentConfig.mock.calls[1][0]).toEqual(persisted);
  });

  it.each(['storage failure', 'transport failure'] as const)(
    'does not write assignments when the queued persisted read has a %s and recovers by reading only',
    async (outcome) => {
      const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      const loadEnvironmentConfig = jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockImplementationOnce(() =>
          outcome === 'transport failure'
            ? Promise.reject(new Error('Assignment read failed.'))
            : Promise.resolve({
                ok: false,
                error: 'Assignment read failed.',
                secureStorageFailure: failure,
              }),
        )
        .mockResolvedValueOnce({ data: config, encryptionAvailable: true });
      const saveEnvironmentConfig = jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockResolvedValue({
          ok: true,
          data: config,
          encryptionAvailable: true,
        });
      installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
      useEnvironmentsStore.setState({ data: config, status: 'ready' });
      await expect(
        useEnvironmentsStore.getState().saveWorkspaceAssignments(config),
      ).rejects.toThrow('Assignment read failed.');
      expect(saveEnvironmentConfig).not.toHaveBeenCalled();
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: config,
        status: 'error',
        storageFailureAction: 'load',
        pendingSave: null,
        secureStorageFailure: outcome === 'storage failure' ? failure : null,
        environmentSaveVersion: 0,
      });
      await useEnvironmentsStore.getState().retryStorageFailure();
      expect(loadEnvironmentConfig).toHaveBeenCalledTimes(2);
      expect(saveEnvironmentConfig).not.toHaveBeenCalled();
      expect(useEnvironmentsStore.getState()).toMatchObject({
        status: 'ready',
        pendingSave: null,
        secureStorageFailure: null,
      });
      // A refused or rejected queue read must not poison subsequent writes.
      await useEnvironmentsStore.getState().save(config);
      expect(saveEnvironmentConfig).toHaveBeenCalledTimes(1);
      expect(useEnvironmentsStore.getState()).toMatchObject({
        status: 'ready',
        environmentSaveVersion: 1,
        lastSavedEnvironmentData: config,
      });
    },
  );

  it('refreshes external environment fields when retrying the original failed assignment intent', async () => {
    const original = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const submitted: EnvironmentConfigData = {
      ...original,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const external: EnvironmentConfigData = {
      ...original,
      globalRuntimes: { ...original.globalRuntimes, agent: 'default-overall' },
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const loadEnvironmentConfig = jest
      .fn<Promise<LoadEnvironmentConfigResponse>, []>()
      .mockResolvedValueOnce({ data: original, encryptionAvailable: true })
      .mockResolvedValueOnce({ data: external, encryptionAvailable: true });
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Assignment write failed.',
        secureStorageFailure: failure,
      })
      .mockImplementationOnce((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    await expect(
      useEnvironmentsStore.getState().saveWorkspaceAssignments(submitted),
    ).rejects.toThrow('Assignment write failed.');
    useEnvironmentsStore
      .getState()
      .setLocal({ ...submitted, workspaceAssignments: [] });
    await useEnvironmentsStore.getState().retryStorageFailure();
    expect(loadEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(saveEnvironmentConfig.mock.calls.map(([data]) => data)).toEqual([
      submitted,
      { ...external, workspaceAssignments: submitted.workspaceAssignments },
    ]);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      status: 'ready',
      environmentSaveVersion: 0,
      lastSavedEnvironmentData: null,
    });
  });

  it.each([
    'success',
    'deleted environment',
    'assignment refusal',
    'assignment rejection',
    'environment retry',
  ] as const)(
    'preserves completed assignment ownership when an environment save queues behind it: %s',
    async (outcome) => {
      const original = createDefaultEnvironmentConfig(
        '2026-05-29T00:00:00.000Z',
      );
      original.environments.push({
        ...original.environments[0],
        id: 'removable',
        name: 'Removable',
        isDefault: false,
      });
      const assignment: EnvironmentConfigData = {
        ...original,
        workspaceAssignments: [
          {
            workspaceId: 'ws-1',
            runtimes: { agent: 'removable', pipeline: 'default-pipeline' },
            updatedAt: '2026-05-29T00:00:00.000Z',
          },
        ],
      };
      // Use a normalized response distinct from the caller snapshot.
      const completedAssignment: EnvironmentConfigData = {
        ...assignment,
        workspaceAssignments: assignment.workspaceAssignments.map((item) => ({
          ...item,
          updatedAt: '2026-05-30T00:00:00.000Z',
        })),
      };
      const environment: EnvironmentConfigData = {
        ...original,
        environments:
          outcome === 'deleted environment'
            ? original.environments.filter((item) => item.id !== 'removable')
            : original.environments,
        globalRuntimes: {
          ...original.globalRuntimes,
          agent: 'default-overall',
        },
      };
      const failure: SecureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      let persisted = original;
      let finishAssignment: () => void = () => undefined;
      let assignmentStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        assignmentStarted = resolve;
      });
      const loadEnvironmentConfig = jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(() => Promise.resolve({ data: persisted, encryptionAvailable: true }));
      const saveEnvironmentConfig = jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finishAssignment = (): void => {
                if (outcome === 'assignment rejection')
                  reject(new Error('Assignment transport failed.'));
                else if (outcome === 'assignment refusal')
                  resolve({
                    ok: false,
                    error: 'Assignment refused.',
                    secureStorageFailure: failure,
                  });
                else {
                  persisted = completedAssignment;
                  resolve({
                    ok: true,
                    data: completedAssignment,
                    encryptionAvailable: true,
                  });
                }
              };
              assignmentStarted();
            }),
        )
        .mockImplementationOnce((data) => {
          if (
            outcome === 'deleted environment' &&
            data.workspaceAssignments.some(
              (item) => item.runtimes.agent === 'removable',
            )
          ) {
            return Promise.resolve({
              ok: false,
              error: 'Assigned environment does not exist.',
            });
          }
          if (outcome === 'environment retry')
            return Promise.resolve({
              ok: false,
              error: 'Environment refused.',
              secureStorageFailure: failure,
            });
          persisted = data;
          return Promise.resolve({ ok: true, data, encryptionAvailable: true });
        })
        .mockImplementationOnce((data) => {
          persisted = data;
          return Promise.resolve({ ok: true, data, encryptionAvailable: true });
        });
      installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
      const assignmentSave = useEnvironmentsStore
        .getState()
        .saveWorkspaceAssignments(assignment);
      const assignmentResult = assignmentSave.then(
        () => null,
        (error: unknown) => error,
      );
      await started;
      const environmentSave = useEnvironmentsStore.getState().save(environment);
      const environmentResult = environmentSave.then(
        () => null,
        (error: unknown) => error,
      );
      finishAssignment();
      const [assignmentError, environmentError] = await Promise.all([
        assignmentResult,
        environmentResult,
      ]);
      const expected: EnvironmentConfigData = {
        ...environment,
        workspaceAssignments: outcome.startsWith('assignment')
          ? []
          : completedAssignment.workspaceAssignments.map((item) => ({
              ...item,
              runtimes: item.runtimes,
            })),
      };
      expect(saveEnvironmentConfig.mock.calls[1][0]).toEqual(expected);
      if (outcome.startsWith('assignment'))
        expect(assignmentError).toBeInstanceOf(Error);
      else expect(assignmentError).toBeNull();
      if (outcome === 'environment retry') {
        expect(environmentError).toBeInstanceOf(Error);
        expect(useEnvironmentsStore.getState().pendingSave).toMatchObject({
          kind: 'environment',
          data: expected,
        });
        useEnvironmentsStore
          .getState()
          .setLocal({ ...environment, workspaceAssignments: [] });
        await useEnvironmentsStore.getState().retryStorageFailure();
        expect(saveEnvironmentConfig.mock.calls[2][0]).toEqual(expected);
        expect(loadEnvironmentConfig).toHaveBeenCalledTimes(1);
      } else if (outcome === 'deleted environment') {
        expect(environmentError).toEqual(
          new Error('Assigned environment does not exist.'),
        );
        expect(persisted).toEqual(completedAssignment);
        expect(useEnvironmentsStore.getState()).toMatchObject({
          status: 'error',
          environmentSaveVersion: 0,
          lastSavedEnvironmentData: null,
        });
        return;
      } else expect(environmentError).toBeNull();
      expect(persisted).toEqual(expected);
      expect(useEnvironmentsStore.getState()).toMatchObject({
        status: 'ready',
        environmentSaveVersion: 1,
        lastSavedEnvironmentData: expected,
      });
    },
  );

  it('leaves an explicit environment payload alone when assignments completed before its request', async () => {
    const original = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const assignment: EnvironmentConfigData = {
      ...original,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const loadEnvironmentConfig = jest
      .fn<Promise<LoadEnvironmentConfigResponse>, []>()
      .mockResolvedValue({ data: original, encryptionAvailable: true });
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockImplementation((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    await useEnvironmentsStore.getState().saveWorkspaceAssignments(assignment);
    await useEnvironmentsStore.getState().save(original);
    expect(saveEnvironmentConfig.mock.calls[1][0]).toEqual(original);
    expect(loadEnvironmentConfig).toHaveBeenCalledTimes(1);
  });

  it('projects completed assignments through a superseded response and newer environment drafts so a later save retains them', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const assignment: EnvironmentConfigData = {
      ...config,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const firstDraft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'default-overall' },
    };
    const newerDraft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, pipeline: 'default-overall' },
    };
    let finishAssignment: () => void = () => undefined;
    let startedAssignment: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedAssignment = resolve;
    });
    let finishEnvironment: () => void = () => undefined;
    let startedEnvironment: () => void = () => undefined;
    const envStarted = new Promise<void>((resolve) => {
      startedEnvironment = resolve;
    });
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockImplementationOnce(
        (data) =>
          new Promise((resolve) => {
            finishAssignment = (): void => {
              resolve({ ok: true, data, encryptionAvailable: true });
            };
            startedAssignment();
          }),
      )
      .mockImplementationOnce(
        (data) =>
          new Promise((resolve) => {
            finishEnvironment = (): void => {
              resolve({ ok: true, data, encryptionAvailable: true });
            };
            startedEnvironment();
          }),
      )
      .mockImplementationOnce((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValue({ data: config, encryptionAvailable: true }),
      saveEnvironmentConfig,
    });
    useEnvironmentsStore.setState({ data: config, status: 'ready' });
    const a = useEnvironmentsStore
      .getState()
      .saveWorkspaceAssignments(assignment);
    await started;
    const e1 = useEnvironmentsStore.getState().save(firstDraft);
    useEnvironmentsStore.getState().setLocal(newerDraft);
    finishAssignment();
    await a;
    const afterAssignment = useEnvironmentsStore.getState();
    await envStarted;
    // Even a newer edit made after the assignment projection must keep it.
    useEnvironmentsStore.getState().setLocal(newerDraft);
    finishEnvironment();
    await e1;
    const afterEnvironment = useEnvironmentsStore.getState();
    const e2Payload = afterEnvironment.data;
    if (!e2Payload) throw new Error('Expected local environment draft.');
    await useEnvironmentsStore.getState().save(e2Payload);
    expect(afterAssignment).toMatchObject({
      data: {
        ...newerDraft,
        workspaceAssignments: assignment.workspaceAssignments,
      },
      status: 'saving',
    });
    expect(afterEnvironment).toMatchObject({
      data: {
        ...newerDraft,
        workspaceAssignments: assignment.workspaceAssignments,
      },
    });
    expect(saveEnvironmentConfig.mock.calls[2][0]).toEqual({
      ...newerDraft,
      workspaceAssignments: assignment.workspaceAssignments,
    });
  });

  it('retains a failed assignment replay through repeated queued read failures and store-only retry', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const submitted: EnvironmentConfigData = {
      ...config,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      ],
    };
    const writeFailure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const readFailure: SecureStorageFailure = {
      ...writeFailure,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
    };
    const loadEnvironmentConfig = jest
      .fn<Promise<LoadEnvironmentConfigResponse>, []>()
      .mockResolvedValueOnce({ data: config, encryptionAvailable: true })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Replay read locked.',
        secureStorageFailure: readFailure,
      })
      .mockRejectedValueOnce(new Error('Replay transport failed.'))
      .mockResolvedValueOnce({ data: config, encryptionAvailable: true });
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Assignment write locked.',
        secureStorageFailure: writeFailure,
      })
      .mockImplementationOnce((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    await expect(
      useEnvironmentsStore.getState().saveWorkspaceAssignments(submitted),
    ).rejects.toThrow('Assignment write locked.');
    useEnvironmentsStore.getState().setLocal(config);
    await expect(
      useEnvironmentsStore.getState().retryStorageFailure(),
    ).rejects.toThrow('Replay read locked.');
    const afterReadFailure = useEnvironmentsStore.getState();
    const secondRetry = useEnvironmentsStore.getState().retryStorageFailure();
    const secondError = await secondRetry.then(
      () => null,
      (error: unknown) => error,
    );
    const afterTransportFailure = useEnvironmentsStore.getState();
    await useEnvironmentsStore.getState().retryStorageFailure();
    expect(afterReadFailure).toMatchObject({
      pendingSave: { kind: 'workspaceAssignments', data: submitted },
      storageFailureAction: 'load',
    });
    expect(secondError).toEqual(new Error('Replay transport failed.'));
    expect(afterTransportFailure).toMatchObject({
      pendingSave: { kind: 'workspaceAssignments', data: submitted },
      storageFailureAction: 'load',
    });
    expect(loadEnvironmentConfig).toHaveBeenCalledTimes(4);
    expect(saveEnvironmentConfig.mock.calls.map(([data]) => data)).toEqual([
      submitted,
      submitted,
    ]);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      status: 'ready',
      pendingSave: null,
      data: submitted,
    });
  });

  it('keeps the draft and refreshes encryption availability after failed read recovery', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const draft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'default-overall' },
    };
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const loadEnvironmentConfig = jest
      .fn<Promise<LoadEnvironmentConfigResponse>, []>()
      .mockResolvedValueOnce({ data: config, encryptionAvailable: true })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Cannot read.',
        secureStorageFailure: failure,
      })
      .mockResolvedValueOnce({ data: config, encryptionAvailable: false });
    installApi({
      loadEnvironmentConfig,
      saveEnvironmentConfig: jest.fn<
        Promise<SaveEnvironmentConfigResponse>,
        [EnvironmentConfigData]
      >(),
    });
    await useEnvironmentsStore.getState().load();
    expect(useEnvironmentsStore.getState().encryptionAvailable).toBe(true);
    useEnvironmentsStore.getState().setLocal(draft);
    await useEnvironmentsStore.getState().load();
    await useEnvironmentsStore.getState().retryStorageFailure();
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: draft,
      encryptionAvailable: false,
      secureStorageFailure: null,
      storageFailureAction: null,
      environmentBaseline: JSON.stringify({
        environments: config.environments,
        globalRuntimes: config.globalRuntimes,
      }),
      status: 'ready',
    });
    const recovered = useEnvironmentsStore.getState();
    const editor = renderToStaticMarkup(
      createElement(EnvironmentVariableEditor, {
        variables: recovered.data?.environments[0]?.variables ?? [],
        uiMode: 'key-value',
        encryptionAvailable: recovered.encryptionAvailable,
        onVariablesChange: () => undefined,
      }),
    );
    expect(editor).toContain('environment-editor-encryption-warning');
    expect(editor).toContain('Values will be saved in plaintext on disk.');
    expect(editor).not.toContain('environment-editor-encryption-status');
  });

  it('records a successful superseded read baseline without losing an edit made while it was pending', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const draft: EnvironmentConfigData = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'default-overall' },
    };
    let resolveLoad: (value: LoadEnvironmentConfigResponse) => void = () =>
      undefined;
    const loadEnvironmentConfig = jest
      .fn<Promise<LoadEnvironmentConfigResponse>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          }),
      )
      .mockResolvedValue({ data: config, encryptionAvailable: true });
    installApi({
      loadEnvironmentConfig,
      saveEnvironmentConfig: jest
        .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
        .mockImplementation((data) =>
          Promise.resolve({ ok: true, data, encryptionAvailable: true }),
        ),
    });
    const load = useEnvironmentsStore.getState().load();
    useEnvironmentsStore.getState().setLocal(draft);
    await useEnvironmentsStore.getState().saveWorkspaceAssignments(config);
    resolveLoad({ data: config, encryptionAvailable: true });
    await load;
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: draft,
      environmentBaseline: JSON.stringify({
        environments: config.environments,
        globalRuntimes: config.globalRuntimes,
      }),
    });
  });

  it('does not replay an obsolete failed environment payload after a later assignment save', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Failed.',
        secureStorageFailure: failure,
      })
      .mockImplementationOnce((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({
      loadEnvironmentConfig: jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockResolvedValue({ data: config, encryptionAvailable: true }),
      saveEnvironmentConfig,
    });
    await expect(useEnvironmentsStore.getState().save(config)).rejects.toThrow(
      'Failed.',
    );
    await useEnvironmentsStore.getState().saveWorkspaceAssignments(config);
    await useEnvironmentsStore.getState().retryStorageFailure();
    expect(saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(useEnvironmentsStore.getState().pendingSave).toBeNull();
  });

  it('reads after an in-flight environment write before adopting data and canonical baseline', async () => {
    const original = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const submitted: EnvironmentConfigData = {
      ...original,
      globalRuntimes: { ...original.globalRuntimes, agent: 'default-overall' },
    };
    let persisted = original;
    let finishSave: () => void = () => undefined;
    const saveEnvironmentConfig = jest.fn<
      Promise<SaveEnvironmentConfigResponse>,
      [EnvironmentConfigData]
    >(
      (data) =>
        new Promise((resolve) => {
          finishSave = (): void => {
            persisted = data;
            resolve({ ok: true, data, encryptionAvailable: true });
          };
        }),
    );
    const loadEnvironmentConfig = jest.fn<
      Promise<LoadEnvironmentConfigResponse>,
      []
    >(() => Promise.resolve({ data: persisted, encryptionAvailable: true }));
    installApi({ loadEnvironmentConfig, saveEnvironmentConfig });
    useEnvironmentsStore.setState({ data: submitted, status: 'ready' });
    const save = useEnvironmentsStore.getState().save(submitted);
    await Promise.resolve();
    const load = useEnvironmentsStore.getState().load();
    await Promise.resolve();
    const earlyReads = loadEnvironmentConfig.mock.calls.length;
    finishSave();
    await Promise.all([save, load]);
    expect(earlyReads).toBe(0);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: submitted,
      environmentBaseline: JSON.stringify({
        environments: submitted.environments,
        globalRuntimes: submitted.globalRuntimes,
      }),
      status: 'ready',
    });
  });

  it.each([false, true])(
    'keeps the newest successful read baseline when two reads complete newer-first: %s',
    async (newerFirst) => {
      const older = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
      const newer: EnvironmentConfigData = {
        ...older,
        globalRuntimes: { ...older.globalRuntimes, agent: 'default-overall' },
      };
      let resolveOlder: (value: LoadEnvironmentConfigResponse) => void = () =>
        undefined;
      let resolveNewer: (value: LoadEnvironmentConfigResponse) => void = () =>
        undefined;
      const loadEnvironmentConfig = jest
        .fn<Promise<LoadEnvironmentConfigResponse>, []>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOlder = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNewer = resolve;
            }),
        );
      installApi({
        loadEnvironmentConfig,
        saveEnvironmentConfig: jest.fn<
          Promise<SaveEnvironmentConfigResponse>,
          [EnvironmentConfigData]
        >(),
      });
      const first = useEnvironmentsStore.getState().load();
      const second = useEnvironmentsStore.getState().load();
      await Promise.resolve();
      if (newerFirst) {
        resolveNewer({ data: newer, encryptionAvailable: true });
        await second;
        resolveOlder({ data: older, encryptionAvailable: true });
        await first;
      } else {
        resolveOlder({ data: older, encryptionAvailable: true });
        await first;
        resolveNewer({ data: newer, encryptionAvailable: true });
        await second;
      }
      expect(useEnvironmentsStore.getState()).toMatchObject({
        data: newer,
        environmentBaseline: JSON.stringify({
          environments: newer.environments,
          globalRuntimes: newer.globalRuntimes,
        }),
      });
    },
  );

  it('serializes physical writes so an older save cannot land last', async () => {
    const config = createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z');
    const newer = {
      ...config,
      globalRuntimes: { ...config.globalRuntimes, agent: 'newer' },
    };
    let resolveFirst: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    const saveEnvironmentConfig = jest
      .fn<Promise<SaveEnvironmentConfigResponse>, [EnvironmentConfigData]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce((data) =>
        Promise.resolve({ ok: true, data, encryptionAvailable: true }),
      );
    installApi({
      loadEnvironmentConfig: jest.fn<
        Promise<LoadEnvironmentConfigResponse>,
        []
      >(),
      saveEnvironmentConfig,
    });
    const first = useEnvironmentsStore.getState().save(config);
    const second = useEnvironmentsStore.getState().save(newer);
    await Promise.resolve();
    expect(saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: true, data: config, encryptionAvailable: true });
    await Promise.all([first, second]);
    expect(saveEnvironmentConfig.mock.calls.map(([data]) => data)).toEqual([
      config,
      newer,
    ]);
    expect(useEnvironmentsStore.getState()).toMatchObject({
      data: newer,
      status: 'ready',
      environmentSaveVersion: 2,
      lastSavedEnvironmentData: newer,
    });
  });
});
