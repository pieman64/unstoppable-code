/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InAppNotificationPreferences } from '@canopy/desktop-shared/types';
import {
  __resetForTests,
  refreshInAppNotificationPrefs,
} from '@/lib/osNotifications';
import {
  useInAppNotificationPlacement,
  withChosenInAppNotificationPlacement,
} from '@/lib/useInAppNotificationPlacement';
import {
  useLabsExperimentsStore,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import { makeTestLabsSnapshot } from '@/test-utils/labsExperiments';

function setStackEnabled(enabled: boolean): void {
  useLabsExperimentsStore.setState({
    snapshot: makeTestLabsSnapshot({
      earlyAccess: !enabled,
      experiments: [
        {
          id: 'stacked-notifications',
          requiresEarlyAccess: false,
          choice: enabled,
        },
      ],
    }),
  });
}

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function prefs(
  placement?: InAppNotificationPreferences['placement'],
): InAppNotificationPreferences {
  return {
    enabled: true,
    ...(placement === undefined ? {} : { placement }),
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
  };
}

function Probe(): JSX.Element {
  return <span data-testid="placement">{useInAppNotificationPlacement()}</span>;
}

describe('useInAppNotificationPlacement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    resetLabsExperimentsStoreForTest();
    act(() => root.unmount());
    document.body.replaceChildren();
    setStackEnabled(false);
  });

  function placement(): string | null | undefined {
    return container.querySelector('[data-testid="placement"]')?.textContent;
  }

  it('defaults to top-right despite a retired false choice', () => {
    setStackEnabled(false);
    refreshInAppNotificationPrefs(prefs());
    act(() => root.render(<Probe />));
    expect(placement()).toBe('top-right');
  });

  it('defaults to the top-right corner with stacked notifications on', () => {
    setStackEnabled(true);
    refreshInAppNotificationPrefs(prefs());
    act(() => root.render(<Probe />));
    expect(placement()).toBe('top-right');
  });

  it('keeps the corner the user picked either way', () => {
    setStackEnabled(true);
    refreshInAppNotificationPrefs(prefs('bottom-left'));
    act(() => root.render(<Probe />));
    expect(placement()).toBe('bottom-left');

    act(() => refreshInAppNotificationPrefs(prefs('top-left')));
    expect(placement()).toBe('top-left');
  });
});

describe('withChosenInAppNotificationPlacement', () => {
  it("marks the corner as the user's choice so the loader keeps it", () => {
    const next = withChosenInAppNotificationPlacement(prefs(), 'bottom-right');

    expect(next.placement).toBe('bottom-right');
    expect(next.placementChosen).toBe(true);
    expect(next.categories).toEqual(prefs().categories);
  });
});
