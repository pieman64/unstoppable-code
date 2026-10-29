/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReleaseNotesEntry } from '@canopy/protocol/release-notes';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { useUpdateState } from '@/hooks/useUpdateState';
import { openReleaseHighlights } from '@/stores/releaseHighlightsStore';
import { CanopyTab } from '../CanopyTab';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Published entries: a stable build only surfaces published releases.
const mockEntries: ReleaseNotesEntry[] = [
  {
    version: '1.10.0',
    releasedOn: '2026-10-01',
    highlights: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
  },
  {
    version: '1.9.0',
    releasedOn: '2026-09-01',
    highlights: [{ title: 'D' }, { title: 'E' }, { title: 'F' }],
  },
];

jest.mock('@/stores/releaseHighlightsStore', () => ({
  openReleaseHighlights: jest.fn(),
  useReleaseHighlightsStore: Object.assign(
    (
      selector: (state: { entries: readonly ReleaseNotesEntry[] }) => unknown,
    ): unknown => selector({ entries: mockEntries }),
    {
      getState: (): {
        loadEntries: () => Promise<readonly ReleaseNotesEntry[]>;
      } => ({ loadEntries: () => Promise.resolve(mockEntries) }),
    },
  ),
}));

jest.mock('@/hooks/useGitHubCliStatus', () => ({
  useGitHubCliStatus: jest.fn(() => ({
    authenticated: true,
    username: 'tester',
    error: null,
    tokenSource: 'gh',
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: true,
  })),
}));

jest.mock('@/hooks/useUpdateState', () => ({ useUpdateState: jest.fn() }));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function mockAppVersion(appVersion: string | null): void {
  jest.mocked(useUpdateState).mockReturnValue({
    appVersion,
    dependencyVersions: null,
    state: { phase: 'idle' },
    refresh: jest.fn(),
  });
}

async function renderTab(): Promise<void> {
  await act(async () => {
    root.render(<CanopyTab />);
    await Promise.resolve();
  });
}

function whatsNewButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="settings-canopy-whats-new"]',
  );
}

beforeEach(() => {
  const snapshot = getDefaultFeatureFlagSnapshot();
  Object.assign(snapshot.values, {
    'canopy-shared-release-notes-enabled': true,
  });
  useFeatureFlagsStore.setState({ snapshot });
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cli: {
        getStatus: jest
          .fn()
          .mockResolvedValue({ state: 'unsupported', reason: 'dev' }),
      },
      loadGitHubPat: jest.fn().mockResolvedValue(''),
      onPreferencesSynced: jest.fn(() => jest.fn()),
      loadPreferences: jest.fn().mockResolvedValue({
        auditRetentionDays: 7,
        autoDownloadUpdates: true,
      }),
      update: { checkForUpdates: jest.fn().mockResolvedValue(undefined) },
    } as Partial<CanopyApi> as CanopyApi,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'api');
  jest.clearAllMocks();
});

describe("CanopyTab What's new row", () => {
  it('opens the resolved release for the installed version', async () => {
    mockAppVersion('1.9.0');
    await renderTab();
    const button = whatsNewButton();
    expect(button?.textContent).toBe('View');
    expect(container.textContent).toContain("What's new");
    expect(container.textContent).toContain(
      'See the highlights for this release.',
    );
    act(() => button?.click());
    expect(jest.mocked(openReleaseHighlights)).toHaveBeenCalledWith(
      mockEntries[1],
    );
  });

  it('hides notes on internal builds', async () => {
    mockAppVersion('internal-88');
    await renderTab();
    act(() => whatsNewButton()?.click());
    expect(whatsNewButton()).toBeNull();
    expect(jest.mocked(openReleaseHighlights)).not.toHaveBeenCalled();
  });

  it('hides the row for an unmatched stable release or an unknown version', async () => {
    mockAppVersion('1.8.0');
    await renderTab();
    expect(whatsNewButton()).toBeNull();

    mockAppVersion(null);
    await renderTab();
    expect(whatsNewButton()).toBeNull();
  });

  it('hides drafts on stable builds and RCs', async () => {
    const previous = [...mockEntries];
    try {
      mockEntries.unshift({
        version: '1.11.0',
        highlights: [{ title: 'G' }, { title: 'H' }, { title: 'I' }],
      });
      mockAppVersion('1.11.0');
      await renderTab();
      expect(whatsNewButton()).toBeNull();

      mockAppVersion('1.11.0-rc.1');
      await renderTab();
      act(() => whatsNewButton()?.click());
      expect(whatsNewButton()).toBeNull();
      expect(jest.mocked(openReleaseHighlights)).not.toHaveBeenCalled();
    } finally {
      mockEntries.length = 0;
      mockEntries.push(...previous);
    }
  });

  it('hides the row for unsupported versions and an empty catalog', async () => {
    mockAppVersion('1.9.0-beta.1');
    await renderTab();
    expect(whatsNewButton()).toBeNull();
    const previous = [...mockEntries];
    try {
      mockEntries.length = 0;
      mockAppVersion('internal-88');
      await renderTab();
      expect(whatsNewButton()).toBeNull();
    } finally {
      mockEntries.push(...previous);
    }
  });
});

it('hides published release notes when the rollout is off', async () => {
  const snapshot = getDefaultFeatureFlagSnapshot();
  Object.assign(snapshot.values, {
    'canopy-shared-release-notes-enabled': false,
  });
  useFeatureFlagsStore.setState({ snapshot });
  mockAppVersion('1.9.0');
  await renderTab();
  expect(whatsNewButton()).toBeNull();
});
