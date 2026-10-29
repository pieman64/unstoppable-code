import type { OrgProjectDeepLinkOpenEvent } from '@canopy/protocol/org-projects';
import {
  flushPendingOrgProjectDeepLink,
  handleOrgProjectDeepLink,
  resetOrgProjectDeepLinkHostForTests,
  setOrgProjectDeepLinkSender,
} from '../deep-link/org-project-deep-link-host';
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => false,
  }),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<{ account: { id: string } }> =>
    Promise.resolve({ account: { id: 'a' } }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    accountEpoch: () => number;
    setContext: () => Promise<void>;
  } => ({
    accountEpoch: (): number => 0,
    setContext: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<{ items: [] }> =>
    Promise.resolve({ items: [] }),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): {
    refresh: () => Promise<{
      error: null;
      context: string;
      projects: [];
    }>;
  } => ({
    refresh: (): Promise<{ error: null; context: string; projects: [] }> =>
      Promise.resolve({ error: null, context: '', projects: [] }),
  }),
}));
const link = {
  destination: 'org-project',
  projectId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
} as const;
describe('organization project deep-link delivery', () => {
  beforeEach((): void => resetOrgProjectDeepLinkHostForTests());
  it('holds the result when no window is alive and delivers to the next one', async () => {
    const dead = jest.fn((): boolean => false);
    setOrgProjectDeepLinkSender(dead);
    handleOrgProjectDeepLink(link);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dead).toHaveBeenCalled();
    const delivered: OrgProjectDeepLinkOpenEvent[] = [];
    setOrgProjectDeepLinkSender((event): boolean => {
      delivered.push(event);
      return true;
    });
    expect(delivered).toEqual([{ ok: false }]);
  });
  it('retries the same sender once the renderer reports ready', async () => {
    // A window can exist while its renderer listener has not attached; the
    // sender reports that as undelivered and the flush after readiness is
    // what actually lands the event.
    let ready = false;
    const sender = jest.fn((): boolean => ready);
    setOrgProjectDeepLinkSender(sender);
    handleOrgProjectDeepLink(link);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sender).toHaveBeenCalledTimes(1);
    ready = true;
    flushPendingOrgProjectDeepLink();
    expect(sender).toHaveBeenCalledTimes(2);
    flushPendingOrgProjectDeepLink();
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it('does not redeliver an event that already reached a window', async () => {
    const live = jest.fn((): boolean => true);
    setOrgProjectDeepLinkSender(live);
    handleOrgProjectDeepLink(link);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(live).toHaveBeenCalledTimes(1);
    flushPendingOrgProjectDeepLink();
    expect(live).toHaveBeenCalledTimes(1);
  });
});
