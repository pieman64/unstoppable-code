/**
 * @jest-environment jsdom
 */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOverlayEscape } from '@canopy/ui-shared/components';
import type { ReleaseNotesEntry } from '@canopy/protocol/release-notes';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useNavigationStore } from '@/stores/navigationStore';
import { useReleaseHighlightsStore } from '@/stores/releaseHighlightsStore';
import { resetReleaseHighlightsWritesForTests } from '@/lib/release-highlights/release-highlights';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ReleaseHighlightsHost } from '../ReleaseHighlightsHost';
import { loadDesktopReleaseNotesEntries } from '@/lib/release-highlights/release-notes-entries';

import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setRollout(enabled: boolean): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-shared-release-notes-enabled'] = enabled;
  act(() => useFeatureFlagsStore.getState().setSnapshot(snapshot));
}

const mockEntries: ReleaseNotesEntry[] = [
  {
    // Draft: a stable build records it silently; an RC previews it.
    version: '1.10.0',
    headline: 'Draft for {app}.',
    highlights: [{ title: 'Draft' }, { title: 'Two' }, { title: 'Three' }],
  },
  {
    version: '1.9.0',
    releasedOn: '2026-10-01',
    headline: 'New in {app}.',
    highlights: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
  },
  {
    version: '1.8.0',
    releasedOn: '2026-09-01',
    highlights: [{ title: 'Old' }, { title: 'Older' }, { title: 'Oldest' }],
  },
] satisfies ReleaseNotesEntry[];
jest.mock('@/lib/release-highlights/release-notes-entries', () => ({
  loadDesktopReleaseNotesEntries: jest.fn(),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

let getAppVersion: jest.Mock;
let savePreferences: jest.Mock;
let getCanopyCloudBaseUrl: jest.Mock;
let openExternal: jest.Mock;
let container: HTMLDivElement;
let root: Root;

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      update: { getAppVersion },
      savePreferences,
      getCanopyCloudBaseUrl,
      browser: { openExternal },
    } as Partial<CanopyApi> as CanopyApi,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function render(node: JSX.Element): void {
  act(() => root.render(node));
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="release-highlights-dialog"]');
}

function BlockingOverlay(): JSX.Element {
  useOverlayEscape(true, () => undefined);
  return <div>Blocking overlay</div>;
}

function capture(
  lastSeenVersion: string | null,
  onboardingCompleted = true,
): void {
  act(() => {
    useReleaseHighlightsStore
      .getState()
      .captureInitialSnapshot({ lastSeenVersion, onboardingCompleted });
  });
}

beforeEach(() => {
  setRollout(true);
  jest.mocked(loadDesktopReleaseNotesEntries).mockResolvedValue(mockEntries);
  getAppVersion = jest.fn().mockResolvedValue('1.9.0');
  savePreferences = jest.fn().mockResolvedValue(makeTestPreferences());
  getCanopyCloudBaseUrl = jest.fn().mockResolvedValue('https://app.test');
  openExternal = jest.fn().mockResolvedValue(undefined);
  installApi();
  useReleaseHighlightsStore.setState({
    entries: [],
    initialSnapshot: null,
    automaticStatus: 'idle',
    queued: null,
    presentation: null,
    manuallyPresentedVersions: [],
    automaticallyPresentedVersions: [],
  });
  useNavigationStore.setState({ settingsOpen: false });
  resetReleaseHighlightsWritesForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'api');
  jest.clearAllMocks();
});

describe('ReleaseHighlightsHost automatic presentation', () => {
  it('shows an upgrade once, records on presentation, and closes without rewriting', async () => {
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();

    expect(dialog()?.textContent).toContain('New in');
    expect(dialog()?.textContent).toContain('Version 1.9.0');
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
    expect(jest.mocked(useCurrentUiStateReporter)).toHaveBeenLastCalledWith(
      'releaseHighlights.dialog',
      { open: true, source: 'automatic', version: '1.9.0' },
    );

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="release-highlights-got-it"]',
        )
        ?.click(),
    );
    expect(dialog()).toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'presented',
    );
  });

  it('shows matching notes on first open after startup gates', async () => {
    capture(null, false);
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
  });

  it('keeps a fresh snapshot when startup gates clear before the version loads', async () => {
    let resolveVersion: (version: string) => void = () => undefined;
    getAppVersion.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveVersion = resolve;
      }),
    );
    capture(null, false);
    render(<ReleaseHighlightsHost ready={false} />);
    render(<ReleaseHighlightsHost ready />);
    resolveVersion('1.9.0');
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
  });

  it('presents without waiting for an origin that never resolves', async () => {
    getCanopyCloudBaseUrl.mockReturnValue(new Promise(() => undefined));
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="release-highlights-full-notes"]'),
    ).toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('stays quiet and writes nothing for the same release', async () => {
    capture('1.9.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('does not mark an unavailable feed as seen; a later session can display it', async () => {
    jest.mocked(loadDesktopReleaseNotesEntries).mockResolvedValueOnce(null);
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'settled',
    );
    act(() => useReleaseHighlightsStore.setState({ automaticStatus: 'idle' }));
    await act(async () =>
      useReleaseHighlightsStore.getState().startAutomaticDecision(),
    );
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('preserves inherited history and presents notes published for the same patch later', async () => {
    getAppVersion.mockResolvedValue('1.9.1');
    capture('1.9.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
    const patch: ReleaseNotesEntry = {
      version: '1.9.1',
      releasedOn: '2026-10-02',
      highlights: [{ title: 'Patch' }, { title: 'Two' }, { title: 'Three' }],
    };
    jest
      .mocked(loadDesktopReleaseNotesEntries)
      .mockResolvedValue([patch, ...mockEntries]);
    act(() => useReleaseHighlightsStore.setState({ automaticStatus: 'idle' }));
    await act(async () =>
      useReleaseHighlightsStore.getState().startAutomaticDecision(),
    );
    await flush();
    expect(dialog()?.textContent).toContain('Version 1.9.1');
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.1',
    });
  });

  it('does nothing until the initial snapshot exists', async () => {
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(getAppVersion).not.toHaveBeenCalled();
    expect(loadDesktopReleaseNotesEntries).not.toHaveBeenCalled();
    capture('1.8.0');
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('keeps the first snapshot even if a later read differs', async () => {
    capture(null, false);
    capture('1.8.0', true);
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('waits for startup gates before presenting and recording an upgrade', async () => {
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready={false} />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(loadDesktopReleaseNotesEntries).not.toHaveBeenCalled();

    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('defers while another modal is open', async () => {
    const other = document.createElement('div');
    other.setAttribute('data-canopy-overlay-root', 'modal');
    document.body.appendChild(other);
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe('queued');

    act(() => other.remove());
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('defers while Settings is open and presents once it closes', async () => {
    useNavigationStore.setState({ settingsOpen: true });
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe('queued');
    expect(savePreferences).not.toHaveBeenCalled();

    act(() => useNavigationStore.setState({ settingsOpen: false }));
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('defers to a root dialog that does not use DialogModal', async () => {
    const other = document.createElement('section');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();

    act(() => other.remove());
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('writes nothing for a release with no catalog entry', async () => {
    getAppVersion.mockResolvedValue('1.12.0');
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'settled',
    );
  });

  it('stays quiet without recording for a stable draft and an RC', async () => {
    getAppVersion.mockResolvedValue('1.10.0');
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    // Nothing is recorded, so a later published patch can still present it.
    expect(savePreferences).not.toHaveBeenCalled();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'settled',
    );

    act(() => root.unmount());
    root = createRoot(container);
    useReleaseHighlightsStore.setState({
      entries: [],
      initialSnapshot: null,
      automaticStatus: 'idle',
      queued: null,
      presentation: null,
      manuallyPresentedVersions: [],
      automaticallyPresentedVersions: [],
    });
    resetReleaseHighlightsWritesForTests();
    getAppVersion.mockResolvedValue('1.10.0-rc.1');
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('defers to an existing shared overlay even without a DialogModal root', async () => {
    capture('1.8.0');
    render(
      <>
        <BlockingOverlay />
        <ReleaseHighlightsHost ready />
      </>,
    );
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('rechecks Settings when a blocking modal closes before React commits', async () => {
    const other = document.createElement('div');
    other.setAttribute('data-canopy-overlay-root', 'modal');
    document.body.appendChild(other);
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    await act(async () => {
      useNavigationStore.setState({ settingsOpen: true });
      other.remove();
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('decides once under Strict Mode and across remounts', async () => {
    capture('1.8.0');
    render(
      <StrictMode>
        <ReleaseHighlightsHost ready />
      </StrictMode>,
    );
    act(() => root.unmount());
    root = createRoot(container);
    render(
      <StrictMode>
        <ReleaseHighlightsHost ready />
      </StrictMode>,
    );
    await flush();
    expect(getAppVersion).toHaveBeenCalledTimes(1);
    expect(
      document.querySelectorAll('[data-testid="release-highlights-dialog"]'),
    ).toHaveLength(1);
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('completes the decision after an unmount and presents on remount', async () => {
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    act(() => root.unmount());
    await flush();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe('queued');
    root = createRoot(container);
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
  });

  it('survives version, save, and origin failures', async () => {
    getAppVersion.mockRejectedValueOnce(new Error('ipc'));
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).toBeNull();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'settled',
    );

    act(() => useReleaseHighlightsStore.setState({ automaticStatus: 'idle' }));
    savePreferences.mockRejectedValue(new Error('disk'));
    getCanopyCloudBaseUrl.mockRejectedValue(new Error('origin'));
    act(() => {
      void useReleaseHighlightsStore.getState().startAutomaticDecision();
    });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="release-highlights-full-notes"]'),
    ).toBeNull();
  });

  it('opens full notes externally and keeps the dialog open on rejection', async () => {
    openExternal.mockRejectedValue(new Error('blocked'));
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="release-highlights-full-notes"]',
    );
    expect(action).not.toBeNull();
    act(() => action?.click());
    await flush();
    // The published 1.9.0 entry links straight to its anchor.
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://app.test/changelog?version=1.9.0#v1-9-0',
    });
    expect(dialog()).not.toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });
});

describe('ReleaseHighlightsHost manual presentation', () => {
  const manualEntry: ReleaseNotesEntry = {
    version: '1.9.0',
    highlights: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
  };

  it('does not record an automatic presentation replaced before the host commits', async () => {
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready={false} />);
    await act(async () =>
      useReleaseHighlightsStore.getState().startAutomaticDecision(),
    );
    await flush();
    act(() => {
      useReleaseHighlightsStore.getState().presentQueuedAutomatic();
      useReleaseHighlightsStore.getState().openManual(manualEntry);
    });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('opens from Settings without changing history and closes on Escape', async () => {
    render(<ReleaseHighlightsHost ready />);
    act(() => useReleaseHighlightsStore.getState().openManual(manualEntry));
    await flush();
    expect(dialog()).not.toBeNull();
    expect(savePreferences).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });

  it('cancels an equivalent queued automatic presentation for the session', async () => {
    const other = document.createElement('div');
    other.setAttribute('data-canopy-overlay-root', 'modal');
    document.body.appendChild(other);
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(useReleaseHighlightsStore.getState().queued).not.toBeNull();

    act(() => useReleaseHighlightsStore.getState().openManual(manualEntry));
    act(() => useReleaseHighlightsStore.getState().close());
    act(() => other.remove());
    await flush();
    expect(dialog()).toBeNull();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'cancelled',
    );
    // The user saw the release from Settings, so it is recorded as seen
    // instead of popping up again on the next launch.
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
  });

  it('cancels an equivalent automatic decision still waiting for the version', async () => {
    let resolveVersion: (version: string) => void = () => undefined;
    getAppVersion.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveVersion = resolve;
      }),
    );
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    act(() => useReleaseHighlightsStore.getState().openManual(manualEntry));
    act(() => useReleaseHighlightsStore.getState().close());
    resolveVersion('1.9.0');
    await flush();
    expect(dialog()).toBeNull();
    expect(useReleaseHighlightsStore.getState().automaticStatus).toBe(
      'cancelled',
    );
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({
      releaseHighlightsLastSeenVersion: '1.9.0',
    });
  });

  it('never reopens a dismissed dialog when the origin resolves late', async () => {
    let resolveOrigin: (value: string) => void = () => undefined;
    getCanopyCloudBaseUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveOrigin = resolve;
      }),
    );
    render(<ReleaseHighlightsHost ready />);
    act(() => useReleaseHighlightsStore.getState().openManual(manualEntry));
    act(() => useReleaseHighlightsStore.getState().close());
    resolveOrigin('https://app.test');
    await flush();
    expect(dialog()).toBeNull();
  });

  it('adds the notes action when the origin resolves while open', async () => {
    render(<ReleaseHighlightsHost ready />);
    act(() => useReleaseHighlightsStore.getState().openManual(manualEntry));
    await flush();
    expect(
      document.querySelector('[data-testid="release-highlights-full-notes"]'),
    ).not.toBeNull();
  });
});

it('does not fetch or record while disabled, and starts when enabled', async () => {
  setRollout(false);
  capture('1.8.0');
  render(<ReleaseHighlightsHost ready />);
  await flush();
  expect(loadDesktopReleaseNotesEntries).not.toHaveBeenCalled();
  expect(savePreferences).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
  setRollout(true);
  await flush();
  expect(dialog()).not.toBeNull();
});

it('disabling hides an open dialog and rejects manual opens', async () => {
  capture('1.8.0');
  render(<ReleaseHighlightsHost ready />);
  await flush();
  expect(dialog()).not.toBeNull();
  setRollout(false);
  act(() => useReleaseHighlightsStore.getState().openManual(mockEntries[1]));
  await flush();
  expect(dialog()).toBeNull();
  expect(useReleaseHighlightsStore.getState().entries).toEqual([]);
});

it('drops a pending read even after the flag is disabled and enabled again', async () => {
  let resolveRead: (entries: readonly ReleaseNotesEntry[]) => void = () =>
    undefined;
  jest.mocked(loadDesktopReleaseNotesEntries).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );
  capture('1.8.0');
  render(<ReleaseHighlightsHost ready />);
  await flush();
  setRollout(false);
  setRollout(true);
  jest.mocked(loadDesktopReleaseNotesEntries).mockResolvedValue([]);
  await flush();
  act(() => resolveRead(mockEntries));
  await flush();
  expect(dialog()).toBeNull();
  expect(savePreferences).not.toHaveBeenCalled();
});

it.each([false, true])(
  'does not repeat committed highlights after a rollout cycle (dismissed %s)',
  async (dismissed) => {
    capture('1.8.0');
    render(<ReleaseHighlightsHost ready />);
    await flush();
    expect(dialog()).not.toBeNull();
    if (dismissed) act(() => useReleaseHighlightsStore.getState().close());
    setRollout(false);
    await flush();
    expect(dialog()).toBeNull();
    setRollout(true);
    await flush();
    expect(dialog()).toBeNull();
    expect(savePreferences).toHaveBeenCalledTimes(1);
  },
);

it('still shows never-presented queued notes after a rollout cycle', async () => {
  capture('1.8.0');
  useNavigationStore.setState({ settingsOpen: true });
  render(<ReleaseHighlightsHost ready />);
  await flush();
  expect(useReleaseHighlightsStore.getState().automaticStatus).toBe('queued');
  expect(dialog()).toBeNull();
  setRollout(false);
  await flush();
  setRollout(true);
  await flush();
  act(() => useNavigationStore.setState({ settingsOpen: false }));
  await flush();
  expect(dialog()).not.toBeNull();
  expect(savePreferences).toHaveBeenCalledTimes(1);
});
