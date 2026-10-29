/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  DataSharingOptInResult,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { makeTestPreferences } from '@/test-utils/preferences';
import { DesktopDataSharingOptIn } from '../DesktopDataSharingOptIn';
import { DataSharingOptInSheetHost } from '../DataSharingOptInSheetHost';
import { useNavigationStore } from '@/stores/navigationStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function account(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: null,
    capabilities: [],
    account: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.test',
      role: 'DEVELOPER',
    },
    organizations: [
      { id: ORG, name: 'Acme' },
      { id: OTHER, name: 'Other' },
    ],
    enforcedSettings: [],
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let currentAccount: CanopyCloudAccountPublicState;
let currentPreferences: PreferencesData;
let preferenceListeners: Array<() => void>;
let enableResult: () => Promise<DataSharingOptInResult>;
const enableDataSharingForFeature = jest.fn(() => enableResult());
const dismissDataSharingOptInHint = jest.fn(() =>
  Promise.resolve({ status: 'saved' as const }),
);

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest.fn(() => Promise.resolve(currentAccount)),
      loadPreferences: jest.fn(() => Promise.resolve(currentPreferences)),
      onPreferencesChanged: jest.fn((cb: () => void) => {
        preferenceListeners.push(cb);
        return (): void => {
          preferenceListeners = preferenceListeners.filter((l) => l !== cb);
        };
      }),
      enableDataSharingForFeature,
      dismissDataSharingOptInHint,
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  currentAccount = account();
  currentPreferences = makeTestPreferences({
    telemetrySharing: {
      metadata: 'private',
      plans: 'private',
      summaries: 'private',
      transcripts: 'private',
    },
  });
  preferenceListeners = [];
  enableResult = (): Promise<DataSharingOptInResult> =>
    Promise.resolve({
      status: 'saved',
      changedScopes: ['metadata', 'transcripts'],
      skippedScopes: [],
    });
  enableDataSharingForFeature.mockClear();
  dismissDataSharingOptInHint.mockClear();
  installApi();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}
const HINT = 'data-sharing-opt-in-organization-memory';

describe('DesktopDataSharingOptIn', () => {
  it('saves once, then keeps the acknowledgment through the broadcast', async () => {
    const onEnabled = jest.fn();
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
          onEnabled={onEnabled}
        />,
      ),
    );
    await flush();
    expect(byId(HINT)?.dataset.optInState).toBe('offer');
    expect(byId(`${HINT}-summary`)?.textContent).toContain(
      'Shares your work stats and chats with Acme',
    );

    const pending = deferred<DataSharingOptInResult>();
    enableResult = (): Promise<DataSharingOptInResult> => pending.promise;
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    // Duplicate submissions are disabled while the save is in flight.
    expect(byId(`${HINT}-enable`)).toHaveProperty('disabled', true);
    act(() => byId(`${HINT}-enable`)?.click());
    expect(enableDataSharingForFeature).toHaveBeenCalledTimes(1);
    expect(enableDataSharingForFeature).toHaveBeenCalledWith({
      feature: 'organization-memory',
      organizationId: ORG,
    });

    currentPreferences = makeTestPreferences({
      telemetrySharing: {
        metadata: 'organization',
        plans: 'private',
        summaries: 'private',
        transcripts: 'organization',
      },
    });
    act(() => {
      pending.resolve({
        status: 'saved',
        changedScopes: ['metadata', 'transcripts'],
        skippedScopes: [],
      });
    });
    await flush();
    preferenceListeners.forEach((listener) => listener());
    await flush();

    expect(byId(HINT)?.dataset.optInState).toBe('enabled');
    expect(byId(HINT)?.textContent).toContain('Sharing settings saved.');
    expect(onEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed application failure visible through reload and really retries', async () => {
    const onEnabled = jest.fn();
    enableResult = async (): Promise<DataSharingOptInResult> => {
      await Promise.resolve();
      currentPreferences = {
        ...currentPreferences,
        telemetrySharing: {
          ...currentPreferences.telemetrySharing,
          metadata: 'organization',
          transcripts: 'organization',
        },
      };
      preferenceListeners.forEach((listener) => listener());
      return {
        status: 'saved-application-failed',
        changedScopes: ['metadata', 'transcripts'],
        skippedScopes: [],
      };
    };
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
          onEnabled={onEnabled}
        />,
      ),
    );
    await flush();
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    expect(byId(HINT)?.textContent).toContain(
      "Sharing settings saved, but couldn't apply them yet.",
    );
    expect(byId(`${HINT}-enable`)?.textContent).toBe('Try again');
    expect(onEnabled).not.toHaveBeenCalled();
    enableResult = (): Promise<DataSharingOptInResult> =>
      Promise.resolve({
        status: 'saved',
        changedScopes: [],
        skippedScopes: [],
      });
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    expect(enableDataSharingForFeature).toHaveBeenCalledTimes(2);
    expect(byId(HINT)?.dataset.optInState).toBe('enabled');
    expect(onEnabled).toHaveBeenCalledTimes(1);
  });

  it('does not save after its fresh consent load was superseded', async () => {
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
        />,
      ),
    );
    await flush();
    const slow = deferred<CanopyCloudAccountPublicState>();
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockImplementation(() => Promise.resolve(currentAccount)),
    });
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    act(() => preferenceListeners.forEach((listener) => listener()));
    await flush();
    await act(async () => {
      slow.resolve(currentAccount);
      await Promise.resolve();
    });
    await flush();
    expect(enableDataSharingForFeature).not.toHaveBeenCalled();
    expect(byId(`${HINT}-enable`)).toHaveProperty('disabled', false);
  });

  it('does not save after the confirmation unmounts during its fresh load', async () => {
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
        />,
      ),
    );
    await flush();
    const slow = deferred<CanopyCloudAccountPublicState>();
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn(() => slow.promise),
    });
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    act(() => root.render(null));
    await act(async () => {
      slow.resolve(currentAccount);
      await Promise.resolve();
    });
    await flush();
    expect(enableDataSharingForFeature).not.toHaveBeenCalled();
  });

  it('asks again instead of saving when policy changed after display', async () => {
    const onEnabled = jest.fn();
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
          onEnabled={onEnabled}
        />,
      ),
    );
    await flush();
    currentAccount = account({
      enforcedSettings: [
        {
          organizationId: ORG,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: {},
              prohibitedScopes: { transcripts: true },
            },
          ],
        },
      ],
    });
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    expect(enableDataSharingForFeature).not.toHaveBeenCalled();
    expect(onEnabled).not.toHaveBeenCalled();
    expect(byId(`${HINT}-summary`)?.textContent).toContain(
      "Acme doesn't allow sharing your chats here.",
    );
  });

  it('maps refusals to recoverable errors without leaking reasons', async () => {
    enableResult = (): Promise<DataSharingOptInResult> =>
      Promise.resolve({
        status: 'refused',
        reason: 'enforcement-unavailable',
      });
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
        />,
      ),
    );
    await flush();
    act(() => byId(`${HINT}-enable`)?.click());
    await flush();
    expect(byId(HINT)?.textContent).toContain(
      "Couldn't confirm your organization's settings.",
    );
    expect(byId(HINT)?.textContent).not.toContain('enforcement');
  });

  it('persists a dismissal and hides the passive hint', async () => {
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
        />,
      ),
    );
    await flush();
    currentPreferences = {
      ...currentPreferences,
      dataSharingOptInHints: {
        'organization-memory': { dismissedAt: '2026-10-01T00:00:00.000Z' },
      },
    };
    act(() => byId(`${HINT}-dismiss`)?.click());
    await flush();
    expect(dismissDataSharingOptInHint).toHaveBeenCalledWith({
      feature: 'organization-memory',
    });
    expect(byId(HINT)).toBeNull();
  });

  it('keeps blocking recovery visible: no dismissal, fallback when unavailable', async () => {
    currentPreferences = {
      ...currentPreferences,
      dataSharingOptInHints: {
        'shared-projects': { dismissedAt: '2026-10-01T00:00:00.000Z' },
      },
    };
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="shared-projects"
          organizationId={ORG}
          dismissible={false}
          fallback={<span data-testid="fallback">Open Privacy settings</span>}
        />,
      ),
    );
    await flush();
    expect(byId('data-sharing-opt-in-shared-projects')).not.toBeNull();
    expect(byId('data-sharing-opt-in-shared-projects-dismiss')).toBeNull();

    currentAccount = account({ enforcedSettings: undefined });
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(byId('data-sharing-opt-in-shared-projects')).toBeNull();
    expect(byId('fallback')).not.toBeNull();
  });

  it('treats a fulfilled preference recovery error as unavailable', async () => {
    Object.assign(window.api, {
      loadPreferences: jest.fn(() =>
        Promise.resolve({
          ...currentPreferences,
          __error: { reason: 'invalid-json', message: 'broken preferences' },
        }),
      ),
    });
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="shared-projects"
          organizationId={ORG}
          dismissible={false}
          fallback={<span data-testid="fallback">Open Privacy settings</span>}
        />,
      ),
    );
    await flush();
    expect(byId('data-sharing-opt-in-shared-projects')).toBeNull();
    expect(byId('fallback')).not.toBeNull();
  });

  it('ignores a stale load after the organization changes', async () => {
    const slow = deferred<CanopyCloudAccountPublicState>();
    const loadAccount = jest
      .fn<Promise<CanopyCloudAccountPublicState>, []>()
      .mockReturnValueOnce(slow.promise)
      .mockImplementation(() =>
        Promise.resolve(
          account({ organizations: [{ id: OTHER, name: 'Other' }] }),
        ),
      );
    Object.assign(window.api, { loadCanopyCloudAccount: loadAccount });
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={ORG}
        />,
      ),
    );
    act(() =>
      root.render(
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={OTHER}
        />,
      ),
    );
    await flush();
    await act(async () => {
      slow.resolve(account());
      await Promise.resolve();
    });
    await flush();
    expect(byId(`${HINT}-enable`)?.textContent).toBe('Share with Other');
  });
});

describe('DataSharingOptInSheetHost', () => {
  const SHEET = 'data-sharing-opt-in-sheet';

  beforeEach(() => {
    useNavigationStore.setState({
      pendingPrivacyOptIn: undefined,
      queuedPrivacyOptIns: [],
    });
  });

  function openSheet(): void {
    act(() => root.render(<DataSharingOptInSheetHost />));
    act(() =>
      useNavigationStore
        .getState()
        .openPrivacyOptIn({ feature: 'leaderboards', organizationId: ORG }),
    );
  }

  it('shows a pending state, then the disclosure, and Cancel writes nothing', async () => {
    const slow = deferred<CanopyCloudAccountPublicState>();
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn(() => slow.promise),
    });
    openSheet();
    expect(byId(`${SHEET}-loading`)).not.toBeNull();
    expect(useNavigationStore.getState().activePage).not.toBe('settings');

    await act(async () => {
      slow.resolve(account());
      await Promise.resolve();
    });
    await flush();
    expect(byId(`${SHEET}-summary`)?.textContent).toContain(
      'Shares your work stats and plans with Acme',
    );
    expect(byId(`${SHEET}-summary`)?.textContent).toContain(
      'This also covers your other organizations, now and later.',
    );
    act(() => byId(`${SHEET}-cancel`)?.click());
    expect(enableDataSharingForFeature).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toBeUndefined();
    expect(byId(SHEET)).toBeNull();
  });

  it('ignores a passive dismissal and saves on Share', async () => {
    currentPreferences = {
      ...currentPreferences,
      dataSharingOptInHints: {
        leaderboards: { dismissedAt: '2026-10-01T00:00:00.000Z' },
      },
    };
    openSheet();
    await flush();
    act(() => byId(`${SHEET}-share`)?.click());
    await flush();
    expect(enableDataSharingForFeature).toHaveBeenCalledWith({
      feature: 'leaderboards',
      organizationId: ORG,
    });
    expect(byId(`${SHEET}-saved`)?.textContent).toContain(
      'Sharing settings saved.',
    );
    act(() => byId(`${SHEET}-done`)?.click());
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toBeUndefined();
  });

  it('shows managed and already-shared states with Done only', async () => {
    currentPreferences = makeTestPreferences({
      telemetrySharing: {
        metadata: 'organization',
        plans: 'organization',
        summaries: 'private',
        transcripts: 'private',
      },
    });
    openSheet();
    await flush();
    expect(byId(`${SHEET}-shared`)?.textContent).toBe(
      'You already share this work with Acme.',
    );
    expect(byId(`${SHEET}-share`)).toBeNull();
    expect(byId(`${SHEET}-done`)).not.toBeNull();
  });

  it('opens Privacy settings without saving when state is unavailable', async () => {
    currentAccount = account({ telemetryEnforcementUnavailable: true });
    const openSettings = jest.spyOn(
      useNavigationStore.getState(),
      'openSettings',
    );
    openSheet();
    await flush();
    expect(enableDataSharingForFeature).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toBeUndefined();
    expect(openSettings).toHaveBeenCalledWith('privacy');
    openSettings.mockRestore();
  });
});
