jest.mock('../feature-flags', () => ({ getFeatureFlagService: jest.fn() }));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));
jest.mock('../services/desktop-session-snapshot-invalidation', () => ({
  scheduleDesktopSessionSnapshotInvalidation: jest.fn(),
}));

import { installOrgProjectSnapshotInvalidation } from '../services/org-project-snapshot-invalidation';

describe('installOrgProjectSnapshotInvalidation', () => {
  it('schedules a snapshot invalidation on catalog, context, and flag changes and unsubscribes', () => {
    const listeners: Array<() => void> = [];
    const unsubscribed: string[] = [];
    const subscribe =
      (name: string) =>
      (listener: () => void): (() => void) => {
        listeners.push(listener);
        return (): void => {
          unsubscribed.push(name);
        };
      };
    const schedule = jest.fn();
    const dispose = installOrgProjectSnapshotInvalidation({
      subscribeCatalog: subscribe('catalog'),
      subscribeWorkspaceContext: subscribe('context'),
      subscribeFeatureFlags: subscribe('flags'),
      schedule,
    });
    expect(listeners).toHaveLength(3);
    for (const listener of listeners) listener();
    expect(schedule).toHaveBeenCalledTimes(3);
    dispose();
    expect(unsubscribed.sort()).toEqual(['catalog', 'context', 'flags']);
  });
});
