/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { SidebarContextEmptyState } from '../SidebarContextEmptyState';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockOpenOrganizationBillingPage = jest.fn<void, [string]>();
jest.mock('@/lib/organizationPlan', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/organizationPlan'),
  openOrganizationBillingPage: (organizationId: string): void => {
    mockOpenOrganizationBillingPage(organizationId);
  },
}));

const ORG = '11111111-1111-4111-8111-111111111111';

describe('SidebarContextEmptyState', () => {
  const originalFlags = useFeatureFlagsStore.getState();
  const originalContext = useWorkspaceContextStore.getState();
  const originalShared = useSharedContainersStore.getState();
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mockOpenOrganizationBillingPage.mockClear();
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useSharedContainersStore.setState({
      orgBillingStates: [
        { organizationId: ORG, organizationName: 'Acme', teamsEntitled: false },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useFeatureFlagsStore.setState(originalFlags, true);
    useWorkspaceContextStore.setState(originalContext, true);
    useSharedContainersStore.setState(originalShared, true);
  });

  function renderAs(
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
    chatsListed = false,
  ): void {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG },
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role }],
      },
    });
    act(() =>
      root.render(
        <SidebarContextEmptyState
          organizationName="Acme"
          organizationId={ORG}
          chatsListed={chatsListed}
        />,
      ),
    );
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('lets an owner choose a plan for an organization with none', () => {
    renderAs('OWNER');
    expect(container.textContent).toContain('Acme has no active plan');
    expect(container.textContent).toContain(
      'Choose a plan to use projects and chats here.',
    );
    const choose = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-context-empty-state-choose-plan"]',
    );
    expect(choose?.textContent).toBe('Choose a plan');
    act(() => choose?.click());
    expect(mockOpenOrganizationBillingPage).toHaveBeenCalledWith(ORG);
    // The sidebar no longer offers the way back to Personal (CAN-3550).
    expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
    expect(container.textContent).not.toContain('Back to Personal');
  });

  it('sends an admin or member to an owner, with no purchase button', () => {
    for (const role of ['ADMIN', 'MEMBER'] as const) {
      renderAs(role);
      expect(container.textContent).toContain('Acme has no active plan');
      expect(container.textContent).toContain(
        'Ask an owner of Acme to choose a plan.',
      );
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-choose-plan"]',
        ),
      ).toBeNull();
      expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
      expect(container.textContent).not.toContain('Back to Personal');
      expect(container.textContent).not.toContain('None found');
    }
  });

  it('stays out of the way when a plan is missing under a listed Chats section', () => {
    renderAs('MEMBER', true);
    expect(byTestId('sidebar-context-empty-state')).toBeNull();
  });

  it.each([false, true])(
    'shows None found for an organization with a plan (Chats listed: %s)',
    (chatsListed: boolean) => {
      useSharedContainersStore.setState({
        orgBillingStates: [
          {
            organizationId: ORG,
            organizationName: 'Acme',
            teamsEntitled: true,
          },
        ],
      });
      renderAs('OWNER', chatsListed);
      expect(byTestId('sidebar-context-empty-state')?.textContent).toBe(
        'None found',
      );
      expect(byTestId('sidebar-context-empty-state-add')).toBeNull();
      expect(byTestId('sidebar-context-empty-state-back')).toBeNull();
      expect(container.textContent).not.toContain('Nothing in Acme yet');
    },
  );
});
