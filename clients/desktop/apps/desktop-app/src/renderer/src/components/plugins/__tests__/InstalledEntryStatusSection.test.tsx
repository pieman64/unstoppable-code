/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('@/hooks/useDesktopInstalledItemStatuses', () => ({
  useDesktopInstalledItemStatuses: (): Record<string, unknown> => ({
    state: { kind: 'loading' },
    pendingKeys: new Set<string>(),
    setStatus: jest.fn(),
    uninstall: jest.fn(),
  }),
}));
jest.mock('@canopy/ui-shared', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/ui-shared'),
  entryHasInstalledStatus: (): boolean => true,
  installedEntryStatusState: (): { kind: 'loading' } => ({ kind: 'loading' }),
  InstalledItemStatusRow: ({
    onUninstall,
  }: {
    onUninstall?: unknown;
  }): JSX.Element => (
    <div
      data-testid="status-row"
      data-uninstall={onUninstall === undefined ? 'none' : 'offered'}
    />
  ),
}));

import { InstalledEntryStatusSection } from '../InstalledEntryStatusSection';

const ENTRY = {
  state: 'installed' as const,
  name: 'Review Checklist',
  ref: {
    type: 'skill' as const,
    sourceId: 'local',
    skillName: 'review-checklist',
  },
};

describe('InstalledEntryStatusSection', () => {
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

  function uninstallOffer(): string | null | undefined {
    return container
      .querySelector('[data-testid="status-row"]')
      ?.getAttribute('data-uninstall');
  }

  it('offers Uninstall where the detail has no removal of its own', () => {
    act(() =>
      root.render(
        <InstalledEntryStatusSection entry={ENTRY} onUninstalled={() => {}} />,
      ),
    );
    expect(uninstallOffer()).toBe('offered');
  });

  it('leaves removal to the header ⋯ when the detail already has one', () => {
    // CAN-4261: a second, orphaned ⋯ under Status duplicated the header's
    // Delete/Remove on a skill detail.
    act(() =>
      root.render(
        <InstalledEntryStatusSection
          entry={ENTRY}
          onUninstalled={() => {}}
          headerOwnsRemoval
        />,
      ),
    );
    expect(uninstallOffer()).toBe('none');
  });
});
