/**
 * @jest-environment jsdom
 */
const mockAddToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));
const mockSwitchChatProject = jest.fn().mockResolvedValue(true);
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { switchChatProject: typeof mockSwitchChatProject } => ({
      switchChatProject: mockSwitchChatProject,
    }),
  },
}));

import { localCollectionEntryId } from '@canopy/ui-app/capability';
import {
  registerNavigationGuard,
  useNavigationStore,
} from '@/stores/navigationStore';
import { COLLECTIONS_CHANGED_EVENT, openInstallReveal } from '../installReveal';
import { installRevealNotice } from '../installRevealNotice';

beforeEach(() => {
  jest.clearAllMocks();
  useNavigationStore.setState({
    activePage: 'overview',
    pendingSkillViewer: undefined,
    pendingPluginsNavigation: undefined,
    pendingPipelineReveal: undefined,
    pendingAutomationReveal: undefined,
    workflowEdit: undefined,
  });
});

describe('installRevealNotice', () => {
  it('names the entity and the outcome', () => {
    expect(installRevealNotice('skill', 'installed')).toBe('Skill installed.');
    expect(installRevealNotice('pipeline', 'updated')).toBe(
      'Workflow updated.',
    );
    expect(installRevealNotice('workspace', 'installed')).toBe(
      'Project added.',
    );
  });

  it("keeps a partial success's own status", () => {
    expect(
      installRevealNotice(
        'collection',
        'installed',
        'Collection installed with 2 items unavailable.',
      ),
    ).toBe('Collection installed with 2 items unavailable.');
  });
});

describe('openInstallReveal', () => {
  it('opens an installed skill in its viewer', () => {
    openInstallReveal({
      target: { entity: 'skill', sourceId: 'custom:app', skillName: 'notes' },
      outcome: 'installed',
    });
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingSkillViewer).toEqual({
      kind: 'installed',
      sourceId: 'custom:app',
      skillName: 'notes',
    });
    expect(mockAddToast).toHaveBeenCalledWith('Skill installed.', 'success');
  });

  it('shows a partial install as a warning, never a success', () => {
    openInstallReveal({
      target: { entity: 'agent', agentId: 'reviewer-2' },
      outcome: 'installed',
      status:
        'Agent installed as reviewer-2 because reviewer already exists locally.',
      partial: true,
    });
    expect(mockAddToast).toHaveBeenCalledWith(
      'Agent installed as reviewer-2 because reviewer already exists locally.',
      'warning',
    );
    // The detail opens on the local id the install returned, not the shared
    // or originally requested id.
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'agent:local:reviewer-2',
      intent: 'view',
    });
  });

  it('opens a plugin on its detail, where setup lives', () => {
    openInstallReveal({
      target: {
        entity: 'plugin',
        marketplaceId: 'mkt',
        pluginName: 'formatter',
        entryId: 'mkt:mkt/formatter',
      },
      outcome: 'installed',
    });
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'mkt:mkt/formatter',
    });
  });

  it('refreshes local collections, then opens the collection detail', () => {
    const changed = jest.fn();
    window.addEventListener(COLLECTIONS_CHANGED_EVENT, changed);
    openInstallReveal({
      target: { entity: 'collection', collectionId: 'col-1' },
      outcome: 'installed',
    });
    window.removeEventListener(COLLECTIONS_CHANGED_EVENT, changed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: localCollectionEntryId('col-1'),
    });
    expect(localCollectionEntryId('col-1')).toBe('collection:local:col-1');
  });

  it('marks a workflow on Workflows → Library', () => {
    openInstallReveal({
      target: { entity: 'pipeline', pipelineId: 'pipe-1' },
      outcome: 'updated',
    });
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('workflows-library');
    expect(state.pendingPipelineReveal).toEqual({ pipelineId: 'pipe-1' });
    expect(mockAddToast).toHaveBeenCalledWith('Workflow updated.', 'success');
  });

  it('opens an agent on its Marketplace detail rather than its editor', () => {
    openInstallReveal({
      target: { entity: 'agent', agentId: 'agent-1' },
      outcome: 'installed',
    });
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'agent:local:agent-1',
      intent: 'view',
    });
    expect(mockAddToast).toHaveBeenCalledWith('Agent installed.', 'success');
  });

  it('opens a project made from a Blueprint', () => {
    openInstallReveal({
      target: { entity: 'workspace', projectId: 'proj-1' },
      outcome: 'installed',
    });
    expect(mockSwitchChatProject).toHaveBeenCalledWith('proj-1');
    expect(useNavigationStore.getState().activePage).toBe('chat');
    expect(mockAddToast).toHaveBeenCalledWith('Project added.', 'success');
  });

  it('hands an automation to its Library reveal, which has its own notice', () => {
    openInstallReveal({
      target: { entity: 'automation', activityId: 'act-1' },
      outcome: 'installed',
    });
    expect(useNavigationStore.getState().pendingAutomationReveal).toEqual({
      activityId: 'act-1',
      outcome: 'installed',
    });
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('still shows the notice when a guarded navigation keeps the user in place', () => {
    const unregister = registerNavigationGuard(() => false);
    try {
      openInstallReveal({
        target: { entity: 'skill', sourceId: 'custom:app', skillName: 'notes' },
        outcome: 'installed',
      });
    } finally {
      unregister();
    }
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(mockAddToast).toHaveBeenCalledWith('Skill installed.', 'success');
  });
});

describe('openShareInstall', () => {
  const first = {
    entity: 'skill' as const,
    externalId: 'a',
    intent: 'install' as const,
  };
  const second = {
    entity: 'skill' as const,
    externalId: 'b',
    intent: 'install' as const,
  };

  beforeEach(() => {
    useNavigationStore.setState({
      pendingShareInstall: undefined,
      heldShareInstall: undefined,
      shareInstallBusy: false,
    });
  });

  it('replaces an idle review at once', () => {
    const store = useNavigationStore.getState();
    store.openShareInstall(first, 'deep-link');
    store.openShareInstall(second, 'in-app');
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: second,
      origin: 'in-app',
    });
  });

  it('holds a request that arrives while the review writes', () => {
    const store = useNavigationStore.getState();
    store.openShareInstall(first, 'deep-link');
    store.setShareInstallBusy(true);
    store.openShareInstall(second, 'in-app');
    store.consumeShareInstall();
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(first);

    store.setShareInstallBusy(false);
    const state = useNavigationStore.getState();
    expect(state.pendingShareInstall).toEqual({
      link: second,
      origin: 'in-app',
    });
    expect(state.heldShareInstall).toBeUndefined();
  });
});
