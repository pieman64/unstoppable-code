/**
 * @jest-environment jsdom
 */
import type {
  BrowserProfileRecord,
  BrowserProfileDataApi,
} from '@canopy/protocol/browser-profiles';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useBrowserStore } from '@/stores/browserStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { BrowserTab } from '../BrowserTab';

describe('BrowserTab', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const preferences = makeTestPreferences({
    inAppBrowserLocalServersOnly: false,
    openAppLinksInBuiltInBrowser: false,
    useAsSystemDefaultBrowser: false,
  });
  const loadPreferences = jest.fn().mockResolvedValue(preferences);
  const savePreferences = jest.fn().mockImplementation((patch) =>
    Promise.resolve({
      ...preferences,
      ...patch,
    }),
  );
  const getDefaultRegistrationStatus = jest.fn();
  const onDefaultRegistrationStatusChanged = jest.fn(() => (): void => {});

  beforeEach(() => {
    jest.clearAllMocks();
    useBrowserStore.setState({
      localServersOnly: false,
      openAppLinksInBuiltInBrowser: false,
      useAsSystemDefaultBrowser: false,
      browserPreferencesLoaded: false,
    });
    getDefaultRegistrationStatus.mockResolvedValue({
      enabled: false,
      registered: false,
      platform: 'darwin',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences,
        savePreferences,
        browser: {
          getDefaultRegistrationStatus,
          onDefaultRegistrationStatusChanged,
          profiles: { list: jest.fn().mockResolvedValue({ profiles: [] }) },
        },
      },
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('defaults unchecked and persists the local-server restriction', async () => {
    const rendered = await renderTab();
    try {
      const toggle = rendered.container.querySelector(
        '[data-testid="settings-browser-local-servers-only"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error('Browser local-server toggle not found');
      }
      expect(toggle.getAttribute('aria-checked')).toBe('false');

      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(savePreferences).toHaveBeenCalledWith({
        inAppBrowserLocalServersOnly: true,
      });
      expect(useBrowserStore.getState().localServersOnly).toBe(true);
    } finally {
      rendered.cleanup();
    }
  });

  it('defaults the app-link toggle off and persists turning it on', async () => {
    const rendered = await renderTab();
    try {
      const toggle = rendered.container.querySelector(
        '[data-testid="settings-browser-open-app-links-in-built-in-browser"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error('App-link toggle not found');
      }
      expect(toggle.getAttribute('aria-checked')).toBe('false');

      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      // In-app routing alone never asks the OS to change its default browser.
      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(savePreferences).toHaveBeenCalledWith({
        openAppLinksInBuiltInBrowser: true,
      });
      expect(useBrowserStore.getState().openAppLinksInBuiltInBrowser).toBe(
        true,
      );
      expect(useBrowserStore.getState().useAsSystemDefaultBrowser).toBe(false);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(
        getToggle(
          rendered.container,
          'settings-browser-use-as-system-default',
        ).getAttribute('aria-checked'),
      ).toBe('false');
    } finally {
      rendered.cleanup();
    }
  });

  it('turns the default-browser setting on without changing app-link routing', async () => {
    const rendered = await renderTab();
    try {
      const toggle = getToggle(
        rendered.container,
        'settings-browser-use-as-system-default',
      );
      expect(toggle.getAttribute('aria-checked')).toBe('false');

      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(savePreferences).toHaveBeenCalledWith({
        useAsSystemDefaultBrowser: true,
      });
      expect(useBrowserStore.getState().useAsSystemDefaultBrowser).toBe(true);
      expect(useBrowserStore.getState().openAppLinksInBuiltInBrowser).toBe(
        false,
      );
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(
        getToggle(
          rendered.container,
          'settings-browser-open-app-links-in-built-in-browser',
        ).getAttribute('aria-checked'),
      ).toBe('false');
    } finally {
      rendered.cleanup();
    }
  });

  it('restores the previous default-browser value when the save fails', async () => {
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const rendered = await renderTab();
    try {
      const toggle = getToggle(
        rendered.container,
        'settings-browser-use-as-system-default',
      );

      await act(async () => {
        toggle.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useBrowserStore.getState().useAsSystemDefaultBrowser).toBe(false);
    } finally {
      rendered.cleanup();
    }
  });

  it('restores the previous app-link value when the save fails', async () => {
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const rendered = await renderTab();
    try {
      const toggle = rendered.container.querySelector(
        '[data-testid="settings-browser-open-app-links-in-built-in-browser"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error('App-link toggle not found');
      }

      await act(async () => {
        toggle.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useBrowserStore.getState().openAppLinksInBuiltInBrowser).toBe(
        false,
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('shows recovery guidance when the OS registration did not take', async () => {
    getDefaultRegistrationStatus.mockResolvedValue({
      enabled: true,
      registered: false,
      platform: 'win32',
      failure: 'user-action-required',
    });
    const rendered = await renderTab();
    try {
      const guidance = rendered.container.querySelector(
        '[data-testid="settings-browser-default-guidance"]',
      );
      expect(guidance).not.toBeNull();
      expect(guidance?.textContent).toContain('Default apps');
    } finally {
      rendered.cleanup();
    }
  });

  it('explains that default-browser registration is unavailable on Linux', async () => {
    getDefaultRegistrationStatus.mockResolvedValue({
      enabled: true,
      registered: false,
      platform: 'linux',
      failure: 'unsupported',
    });
    const rendered = await renderTab();
    try {
      const guidance = rendered.container.querySelector(
        '[data-testid="settings-browser-default-guidance"]',
      );
      expect(guidance?.textContent).toContain('not available on Linux yet');
    } finally {
      rendered.cleanup();
    }
  });

  it('shows recovery guidance when disabling leaves the app registered', async () => {
    getDefaultRegistrationStatus.mockResolvedValue({
      enabled: false,
      registered: true,
      platform: 'win32',
      failure: 'registration-refused',
    });
    const rendered = await renderTab();
    try {
      const guidance = rendered.container.querySelector(
        '[data-testid="settings-browser-default-guidance"]',
      );
      expect(guidance).not.toBeNull();
      expect(guidance?.textContent).toContain('default browser');
    } finally {
      rendered.cleanup();
    }
  });

  it('refreshes OS registration status when the app regains focus', async () => {
    getDefaultRegistrationStatus
      .mockResolvedValueOnce({
        enabled: true,
        registered: false,
        platform: 'win32',
        failure: 'user-action-required',
      })
      .mockResolvedValueOnce({
        enabled: true,
        registered: true,
        platform: 'win32',
      });
    const rendered = await renderTab();
    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-browser-default-guidance"]',
        ),
      ).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });

      expect(getDefaultRegistrationStatus).toHaveBeenCalledTimes(2);
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-browser-default-guidance"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('shows no guidance once the registration is verified', async () => {
    getDefaultRegistrationStatus.mockResolvedValue({
      enabled: true,
      registered: true,
      platform: 'darwin',
    });
    const rendered = await renderTab();
    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-browser-default-guidance"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });
});

function getToggle(container: HTMLElement, testId: string): HTMLButtonElement {
  const toggle = container.querySelector(`[data-testid="${testId}"]`);
  if (!(toggle instanceof HTMLButtonElement)) {
    throw new Error(`Toggle ${testId} not found`);
  }
  return toggle;
}

async function renderTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<BrowserTab />);
    await Promise.resolve();
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe('Browser profile inventory completion', () => {
  it('refreshes the measured summary when a job completes before updating its terminal label', async () => {
    const { BrowserProfileDataSettings } =
      await import('../BrowserProfileDataSettings');
    const profile = {
      profileId: 'named',
      storageGeneration: 1,
      metadataRevision: 1,
      kind: 'named',
    } as BrowserProfileRecord;
    const empty = {
      profileId: 'named',
      storageGeneration: 1,
      approximateBytes: null,
      measuredAt: null,
      coverage: 'unknown',
      classBytes: { cache: null, indexedDB: null, opfs: null },
      sites: [],
      cookieDomains: [],
      truncated: false,
    };
    let measured = false;
    const api = {
      inventoryGet: jest.fn(() =>
        Promise.resolve({
          ...empty,
          approximateBytes: measured ? 4096 : null,
        }),
      ),
      jobList: jest.fn(() => Promise.resolve({ jobs: [] })),
      inventoryStart: jest.fn(() =>
        Promise.resolve({
          jobId: 'scan',
          profileId: 'named',
          storageGeneration: 1,
          kind: 'inventory',
          status: 'running',
          cancellable: true,
        }),
      ),
      jobGet: jest.fn(() => {
        measured = true;
        return Promise.resolve({
          jobId: 'scan',
          kind: 'inventory',
          status: 'complete',
          cancellable: false,
        });
      }),
    } as unknown as BrowserProfileDataApi;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    jest.useFakeTimers();
    let finishChange!: () => void;
    const changed = (): Promise<void> =>
      new Promise((resolve) => {
        finishChange = resolve;
      });
    try {
      await act(() => {
        root.render(
          <BrowserProfileDataSettings
            profile={profile}
            api={api}
            onChanged={changed}
          />,
        );
        return Promise.resolve();
      });
      await act(() => {
        (
          container.querySelector(
            '[data-testid="browser-profile-measure"]',
          ) as HTMLButtonElement
        ).click();
        return Promise.resolve();
      });
      // Render the job response while its separate metadata refresh is pending.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
      });
      await act(() => {
        finishChange();
        return Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="browser-profile-data-job"]')
          ?.textContent,
      ).toContain('Complete');
      expect(
        container.querySelector('[data-testid="browser-profile-storage-total"]')
          ?.textContent,
      ).toContain('4 KiB');
      expect((api.inventoryGet as jest.Mock).mock.calls).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });

  it('retries transient polling failures and publishes the terminal job', async () => {
    const { BrowserProfileDataSettings } =
      await import('../BrowserProfileDataSettings');
    const current: BrowserProfileRecord = {
      schemaVersion: 1,
      profileId: 'profile-a',
      kind: 'named',
      owner: { kind: 'user', localPrincipalId: 'local-user' },
      displayName: 'Account A',
      metadataRevision: 1,
      agentPermissions: { allowEnable: false, allowClear: false },
      lifecycle: 'active',
      storageGeneration: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const running = {
      jobId: 'scan-retry',
      profileId: current.profileId,
      storageGeneration: current.storageGeneration,
      kind: 'inventory',
      status: 'running',
      cancellable: true,
    };
    const jobGet = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary IPC failure'))
      .mockResolvedValue({
        ...running,
        status: 'complete',
        cancellable: false,
      });
    const api = {
      jobList: jest.fn().mockResolvedValue({ jobs: [running] }),
      inventoryGet: jest.fn().mockResolvedValue({
        profileId: current.profileId,
        storageGeneration: current.storageGeneration,
        measuredAt: null,
        approximateBytes: null,
        coverage: 'unknown',
        classBytes: { cache: null, indexedDB: null, opfs: null },
        sites: [],
        cookieDomains: [],
        truncated: false,
      }),
      jobGet,
    } as unknown as BrowserProfileDataApi;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    jest.useFakeTimers();
    try {
      await act(() => {
        root.render(
          <BrowserProfileDataSettings
            profile={current}
            api={api}
            onChanged={() => Promise.resolve()}
          />,
        );
        return Promise.resolve();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(jobGet).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('[data-testid="browser-profile-data-job"]')
          ?.textContent,
      ).toContain('Complete');
    } finally {
      act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });
});

// Integrated final-review regressions: the real Settings components retain
// request identity across asynchronous replies and generation-changing reset.
describe('browser profile final-review transitions', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const profile = (
    profileId: string,
    displayName: string,
  ): BrowserProfileRecord => ({
    schemaVersion: 1,
    profileId,
    displayName,
    kind: 'named',
    owner: { kind: 'user', localPrincipalId: 'local-user' },
    storageGeneration: 2,
    metadataRevision: 2,
    agentPermissions: { allowEnable: false, allowClear: false },
    lifecycle: 'active',
    createdAt: 1,
    updatedAt: 1,
  });
  afterEach(() => {
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
  });
  const click = async (
    container: HTMLElement,
    testId: string,
  ): Promise<void> => {
    const target = container.querySelector(`[data-testid="${testId}"]`);
    if (!(target instanceof HTMLButtonElement))
      throw new Error(`Missing button: ${testId}`);
    await act(() => {
      target.click();
      return Promise.resolve();
    });
  };

  it.each([false, true])(
    'W2 invalidates a delayed delete preview after selection changes (return to A: %s)',
    async (returnToA) => {
      const { BrowserProfilesSettings } =
        await import('../BrowserProfilesSettings');
      const a = profile('profile-a', 'Account A');
      const b = profile('profile-b', 'Account B');
      let release!: (value: unknown) => void;
      const previewDelete = jest.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const remove = jest.fn();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          browser: {
            profiles: {
              list: jest.fn().mockResolvedValue({ profiles: [a, b] }),
              cleanupStatus: jest.fn().mockResolvedValue({ jobs: [] }),
              jobList: jest.fn().mockResolvedValue({ jobs: [] }),
              inventoryGet: jest.fn().mockResolvedValue(undefined),
              previewDelete,
              delete: remove,
            },
          },
        },
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(() => {
          root.render(<BrowserProfilesSettings />);
          return Promise.resolve();
        });
        await click(container, 'browser-profile-row-profile-a');
        expect(
          container.querySelector(
            '[data-testid="browser-profile-row-profile-a"]',
          )?.classList,
        ).toContain('ring-line-accent');
        await click(container, 'browser-profile-delete');
        expect(previewDelete).toHaveBeenCalledWith({
          profileId: a.profileId,
          expectedMetadataRevision: a.metadataRevision,
        });
        await click(container, 'browser-profile-row-profile-b');
        if (returnToA) await click(container, 'browser-profile-row-profile-a');
        await act(() => {
          release({
            token: 'preview-a',
            profileId: a.profileId,
            metadataRevision: a.metadataRevision,
            tabs: [],
            defaults: [],
          });
          return Promise.resolve();
        });
        expect(
          container.querySelector(
            '[data-testid="browser-profile-delete-preview"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector(
            '[data-testid="browser-profile-confirm-delete"]',
          ),
        ).toBeNull();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('W3 discovers the blocking original-generation reset before current-generation inventory and retries the same job', async () => {
    const { BrowserProfileDataSettings } =
      await import('../BrowserProfileDataSettings');
    const current = profile('profile-a', 'Account A');
    const reset = {
      jobId: 'original-reset',
      profileId: current.profileId,
      storageGeneration: 1,
      kind: 'reset',
      status: 'failed',
      retryable: true,
      cancellable: false,
    };
    const retryJob = jest
      .fn()
      .mockResolvedValue({ ...reset, status: 'complete', retryable: false });
    const clear = jest.fn();
    const api = {
      jobList: jest.fn().mockResolvedValue({
        jobs: [
          {
            jobId: 'new-inventory',
            profileId: current.profileId,
            storageGeneration: 2,
            kind: 'inventory',
            status: 'failed',
            retryable: false,
          },
          reset,
        ],
      }),
      inventoryGet: jest.fn().mockResolvedValue(undefined),
      retryJob,
      clear,
    } as unknown as BrowserProfileDataApi;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(
          <BrowserProfileDataSettings
            profile={current}
            api={api}
            onChanged={() => Promise.resolve()}
          />,
        );
        return Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="browser-profile-data-job"]')
          ?.textContent,
      ).toContain('Data cleanup');
      await click(container, 'browser-profile-retry-job');
      expect(retryJob).toHaveBeenCalledWith({ jobId: 'original-reset' });
      expect(clear).not.toHaveBeenCalled();
      expect(current.storageGeneration).toBe(2);
      expect(
        container.querySelector('[data-testid="browser-profile-data-job"]')
          ?.textContent,
      ).toContain('Complete');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

/**
 * Coverage for the review fixes on this surface: a terminal job must not be
 * described with in-progress copy, `interrupted` must not leak its wire value,
 * a failed cleanup must keep saying why, the delete confirmation must carry
 * keyboard focus, and a row must stay distinguishable from its twin.
 */
describe('browser profile review fixes', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const named = (
    profileId: string,
    displayName: string,
  ): BrowserProfileRecord => ({
    schemaVersion: 1,
    profileId,
    displayName,
    kind: 'named',
    owner: { kind: 'user', localPrincipalId: 'local-user' },
    storageGeneration: 1,
    metadataRevision: 1,
    agentPermissions: { allowEnable: false, allowClear: false },
    lifecycle: 'active',
    createdAt: 1,
    updatedAt: 1,
  });
  const taskProfile = (
    profileId: string,
    worktreeId: string,
  ): BrowserProfileRecord => ({
    ...named(profileId, 'Task'),
    kind: 'task',
    owner: {
      kind: 'task',
      taskScope: { kind: 'worktree', projectId: 'ws', worktreeId },
      taskIncarnationId: 'inc',
    },
  });

  afterEach(() => {
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
    useProjectsStore.setState({ projects: [] });
  });

  const runningReset = {
    jobId: 'reset',
    profileId: 'p1',
    storageGeneration: 1,
    kind: 'reset',
    status: 'running',
    cancellable: true,
  };

  /**
   * Render the panel on a running cleanup, then let one poll land `settles`.
   * A terminal job is only ever reached through this transition — the mount
   * path adopts active and failed jobs only — so the copy under test has to be
   * exercised the same way the user meets it.
   */
  const renderJobTransition = async (
    settles?: Record<string, unknown>,
    base: Record<string, unknown> = {},
  ): Promise<{ text: () => string; cleanup: () => void }> => {
    const { BrowserProfileDataSettings } =
      await import('../BrowserProfileDataSettings');
    const job = { ...runningReset, ...base };
    const api = {
      jobList: jest.fn().mockResolvedValue({ jobs: [job] }),
      inventoryGet: jest.fn().mockResolvedValue(undefined),
      jobGet: jest.fn().mockResolvedValue({ ...job, ...settles }),
    } as unknown as BrowserProfileDataApi;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    jest.useFakeTimers();
    await act(() => {
      root.render(
        <BrowserProfileDataSettings
          profile={named('p1', 'Work')}
          api={api}
          onChanged={() => Promise.resolve()}
        />,
      );
      return Promise.resolve();
    });
    if (settles)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(600);
      });
    return {
      text: (): string =>
        container.querySelector('[data-testid="browser-profile-data-job"]')
          ?.textContent ?? '',
      cleanup: (): void => {
        act(() => root.unmount());
        container.remove();
        jest.useRealTimers();
      },
    };
  };

  it.each([
    ['complete', 'Complete', 'Removed the browser data for this profile'],
    ['cancelled', 'Cancelled', 'stopped'],
    ['failed', 'Failed', 'could not finish'],
    ['interrupted', 'Interrupted', 'was interrupted'],
  ])(
    'labels a %s cleanup and describes it in terminal terms',
    async (status, label, phrase) => {
      const { text, cleanup } = await renderJobTransition({
        status,
        cancellable: false,
      });
      try {
        expect(text()).toContain(`Data cleanup: ${label}`);
        // The raw wire value must never stand in for the label.
        expect(text()).not.toContain(`Data cleanup: ${status}`);
        expect(text()).toContain(phrase);
        // No in-flight wording on a job that has already stopped.
        expect(text()).not.toContain('Removing the browser data');
      } finally {
        cleanup();
      }
    },
  );

  it.each([
    ['cache', 'the HTTP cache'],
    ['site', 'the selected site data'],
    ['reset', 'the browser data for this profile'],
  ])('names what a %s cleanup actually touched', async (kind, subject) => {
    const { text, cleanup } = await renderJobTransition(
      { status: 'complete', cancellable: false },
      { kind },
    );
    try {
      expect(text()).toContain(`Removed ${subject}.`);
      // A scoped clear must never claim the whole profile was wiped: that is
      // the one outcome a user would act on by re-authenticating everywhere.
      if (kind !== 'reset')
        expect(text()).not.toContain('the browser data for this profile');
    } finally {
      cleanup();
    }
  });

  it.each([
    ['cache', 'the HTTP cache'],
    ['site', 'the selected site data'],
  ])(
    'scopes the in-flight and stopped copy for a %s cleanup',
    async (kind, subject) => {
      const running = await renderJobTransition(undefined, { kind });
      try {
        expect(running.text()).toContain(`Removing ${subject}.`);
      } finally {
        running.cleanup();
      }
      const stopped = await renderJobTransition(
        { status: 'interrupted', cancellable: false },
        { kind },
      );
      try {
        expect(stopped.text()).toContain(
          `Some of ${subject} may still be stored.`,
        );
      } finally {
        stopped.cleanup();
      }
    },
  );

  it('keeps the in-flight description for a running cleanup', async () => {
    const { text, cleanup } = await renderJobTransition();
    try {
      expect(text()).toContain('Data cleanup: Running');
      expect(text()).toContain('Removing the browser data');
    } finally {
      cleanup();
    }
  });

  const renderSettings = async (
    overrides: Record<string, unknown>,
  ): Promise<{ container: HTMLElement; cleanup: () => void }> => {
    const { BrowserProfilesSettings } =
      await import('../BrowserProfilesSettings');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          profiles: {
            list: jest.fn().mockResolvedValue({ profiles: [] }),
            cleanupStatus: jest.fn().mockResolvedValue({ jobs: [] }),
            jobList: jest.fn().mockResolvedValue({ jobs: [] }),
            inventoryGet: jest.fn().mockResolvedValue(undefined),
            ...overrides,
          },
        },
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() => {
      root.render(<BrowserProfilesSettings />);
      return Promise.resolve();
    });
    return {
      container,
      cleanup: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it('carries a failed cleanup reason into the summary', async () => {
    const { container, cleanup } = await renderSettings({
      cleanupStatus: jest.fn().mockResolvedValue({
        jobs: [
          { status: 'pending_restart' },
          { status: 'failed', message: 'A file is still open in another app.' },
        ],
      }),
    });
    try {
      const notice = container.querySelector(
        '[data-testid="browser-profile-cleanup-jobs"]',
      )?.textContent;
      expect(notice).toContain('1 waiting for an app restart');
      expect(notice).toContain('1 needing attention');
      expect(notice).toContain('A file is still open in another app.');
    } finally {
      cleanup();
    }
  });

  it('shows a skeleton for the first page only and keeps rows while loading more', async () => {
    let resolveFirst: (page: unknown) => void = () => undefined;
    const list = jest
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(new Promise(() => undefined));
    const { container, cleanup } = await renderSettings({ list });
    const skeleton = (): Element | null =>
      container.querySelector('[data-testid="browser-profiles-loading"]');
    try {
      expect(skeleton()).not.toBeNull();
      expect(container.textContent).not.toContain('Loading profiles');

      await act(async () => {
        resolveFirst({ profiles: [named('p1', 'Work')], nextOffset: 1 });
        await Promise.resolve();
      });
      expect(skeleton()).toBeNull();

      const loadMore = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Load more profiles',
      );
      if (!loadMore) throw new Error('Missing load more button');
      await act(async () => {
        loadMore.click();
        await Promise.resolve();
      });
      // The listed profile stays; no skeleton replaces it.
      expect(skeleton()).toBeNull();
      expect(
        container.querySelector('[data-testid="browser-profile-row-p1"]'),
      ).not.toBeNull();
      expect(loadMore.disabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('qualifies only the row whose name another profile is using', async () => {
    const { container, cleanup } = await renderSettings({
      list: jest.fn().mockResolvedValue({
        profiles: [
          named('dupe-one', 'Work'),
          named('dupe-two', 'Work'),
          named('solo', 'Personal'),
        ],
      }),
    });
    try {
      const rowText = (id: string): string =>
        container.querySelector(`[data-testid="browser-profile-row-${id}"]`)
          ?.textContent ?? '';
      expect(rowText('dupe-one')).toContain('dupe-o');
      expect(rowText('dupe-two')).toContain('dupe-t');
      expect(rowText('solo')).toBe('Personal');
    } finally {
      cleanup();
    }
  });

  it('falls through to the short id when the owning worktree is gone', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'ws',
          type: 'single-repo',
          name: 'Canopy',
          color: '#000000',
          collapsed: false,
          order: 0,
          repoPath: '/tmp/repo',
          worktrees: [],
        },
      ] as unknown as SidebarItem[],
    });
    const { container, cleanup } = await renderSettings({
      list: jest.fn().mockResolvedValue({
        profiles: [
          taskProfile('aaaaaa-one', 'gone-a'),
          taskProfile('bbbbbb-two', 'gone-b'),
        ],
      }),
    });
    try {
      const rowText = (id: string): string =>
        container.querySelector(`[data-testid="browser-profile-row-${id}"]`)
          ?.textContent ?? '';
      // The workspace name alone would render both rows identically.
      expect(rowText('aaaaaa-one')).not.toContain('Canopy');
      expect(rowText('aaaaaa-one')).toContain('aaaaaa');
      expect(rowText('bbbbbb-two')).toContain('bbbbbb');
      expect(rowText('aaaaaa-one')).not.toBe(rowText('bbbbbb-two'));
    } finally {
      cleanup();
    }
  });

  it('moves focus into the delete confirmation and back out on cancel', async () => {
    const { container, cleanup } = await renderSettings({
      list: jest.fn().mockResolvedValue({ profiles: [named('p1', 'Work')] }),
      previewDelete: jest.fn().mockResolvedValue({
        token: 'preview',
        profileId: 'p1',
        metadataRevision: 1,
        tabs: [],
        defaults: [],
      }),
    });
    try {
      const press = async (testId: string): Promise<HTMLButtonElement> => {
        const target = container.querySelector(
          `[data-testid="${testId}"]`,
        ) as HTMLButtonElement;
        await act(() => {
          target.focus();
          target.click();
          return Promise.resolve();
        });
        return target;
      };
      await press('browser-profile-row-p1');
      await press('browser-profile-delete');
      const dialog = container.querySelector(
        '[data-testid="browser-profile-delete-preview"]',
      );
      expect(dialog).not.toBeNull();
      // The trigger is unmounted by now, so focus has to have been moved.
      expect(document.activeElement).toBe(dialog);

      const cancel = Array.from(dialog?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Cancel',
      );
      await act(() => {
        cancel?.click();
        return Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="browser-profile-delete-preview"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="browser-profile-delete"]'),
      );
    } finally {
      cleanup();
    }
  });
});

/**
 * Dismissing the delete confirmation is not the only way it closes: picking a
 * different profile clears it too. Only the first is a reason to move focus.
 */
describe('browser profile delete prompt focus ownership', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const named = (
    profileId: string,
    displayName: string,
  ): BrowserProfileRecord => ({
    schemaVersion: 1,
    profileId,
    displayName,
    kind: 'named',
    owner: { kind: 'user', localPrincipalId: 'local-user' },
    storageGeneration: 1,
    metadataRevision: 1,
    agentPermissions: { allowEnable: false, allowClear: false },
    lifecycle: 'active',
    createdAt: 1,
    updatedAt: 1,
  });

  afterEach(() => {
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
  });

  const open = async (): Promise<{
    container: HTMLElement;
    press: (testId: string) => Promise<void>;
    cleanup: () => void;
  }> => {
    const { BrowserProfilesSettings } =
      await import('../BrowserProfilesSettings');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          profiles: {
            list: jest.fn().mockResolvedValue({
              profiles: [named('alpha', 'Alpha'), named('beta', 'Beta')],
            }),
            cleanupStatus: jest.fn().mockResolvedValue({ jobs: [] }),
            jobList: jest.fn().mockResolvedValue({ jobs: [] }),
            inventoryGet: jest.fn().mockResolvedValue(undefined),
            previewDelete: jest.fn().mockResolvedValue({
              token: 'preview',
              profileId: 'alpha',
              metadataRevision: 1,
              tabs: [],
              defaults: [],
            }),
          },
        },
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() => {
      root.render(<BrowserProfilesSettings />);
      return Promise.resolve();
    });
    const press = async (testId: string): Promise<void> => {
      const target = container.querySelector(`[data-testid="${testId}"]`);
      if (!(target instanceof HTMLButtonElement))
        throw new Error(`Missing button: ${testId}`);
      await act(() => {
        target.focus();
        target.click();
        return Promise.resolve();
      });
    };
    await press('browser-profile-row-alpha');
    await press('browser-profile-delete');
    return {
      container,
      press,
      cleanup: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it('leaves focus alone when another profile closes the prompt', async () => {
    const { container, press, cleanup } = await open();
    try {
      expect(
        container.querySelector(
          '[data-testid="browser-profile-delete-preview"]',
        ),
      ).not.toBeNull();

      await press('browser-profile-row-beta');

      // The prompt is gone because the selection changed, not because the user
      // dismissed it. Focus must stay on the row they clicked — never jump to
      // a different profile's destructive control.
      expect(
        container.querySelector(
          '[data-testid="browser-profile-delete-preview"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="browser-profile-row-beta"]'),
      );
      expect(document.activeElement).not.toBe(
        container.querySelector('[data-testid="browser-profile-delete"]'),
      );
    } finally {
      cleanup();
    }
  });

  it('still returns focus to the trigger when the user cancels', async () => {
    const { container, cleanup } = await open();
    try {
      const cancel = Array.from(
        container
          .querySelector('[data-testid="browser-profile-delete-preview"]')
          ?.querySelectorAll('button') ?? [],
      ).find((button) => button.textContent === 'Cancel');
      await act(() => {
        cancel?.click();
        return Promise.resolve();
      });
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="browser-profile-delete"]'),
      );
    } finally {
      cleanup();
    }
  });
});
