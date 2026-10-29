/**
 * @jest-environment jsdom
 */
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  useProjectsStore.setState({ projects: [] });
  usePipelineRunsStore.setState({
    currentCwd: null,
    currentProjectId: null,
    currentWorktreeId: null,
    summaries: [],
    statesById: {},
  });
  useCanopyPortalStore.setState({
    hydrated: true,
    state: {
      status: 'disabled',
      connectionStatus: 'inactive',
      selectedServerId: null,
      selectedServerName: null,
      selectedServerBaseUrl: null,
      sessionId: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      activatedAt: null,
      lastSeenAt: null,
      lastErrorAt: null,
      error: null,
    },
  });
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
  useFeatureFlagsStore.getState().setSnapshot({
    values: {
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
});

describe('buildCurrentUiStateSnapshot shared-container recipient slice', () => {
  it.each(['symlink-unsupported', 'repository-access-missing'])(
    'projects only the recipient metadata needed by Advisor for %s',
    (blockedReason) => {
      const snapshot = buildCurrentUiStateSnapshot({
        'sharedContainers.recipientSurface': {
          open: true,
          containerId: 'container-1',
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
          containerTitle: 'Shared worktree',
          status: 'blocked',
          blockedReason,
          repository: 'acme/private-repository',
          withheldFileCount: -3,
          listedContainerCount: 2.8,
          transcript: 'must never leave the renderer',
          filePath: '/private/repository/secret.ts',
        },
      });

      expect(snapshot.sharedContainersRecipientSurface).toEqual({
        open: true,
        containerId: 'container-1',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
        containerTitle: 'Shared worktree',
        status: 'blocked',
        blockedReason,
        withheldFileCount: 0,
        listedContainerCount: 2,
      });
      expect(JSON.stringify(snapshot)).not.toContain('must never');
      expect(JSON.stringify(snapshot)).not.toContain('/private/repository');
      expect(JSON.stringify(snapshot)).not.toContain('acme/private-repository');
    },
  );

  it('reports the Past shares page and the removed count, and nothing else about them', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.recipientSurface': {
        open: false,
        pastSharesOpen: true,
        removedShareCount: 3.7,
        removedEntries: [{ title: 'must never leave the renderer' }],
      },
    });

    expect(snapshot.sharedContainersRecipientSurface).toEqual({
      open: false,
      pastSharesOpen: true,
      removedShareCount: 3,
    });
    expect(JSON.stringify(snapshot)).not.toContain('must never');
  });

  it('drops invalid enums and bounds the reported title', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.recipientSurface': {
        open: 'yes',
        containerType: 'UNKNOWN',
        containerTitle: 'x'.repeat(250),
        status: 'secret-status',
        blockedReason: 'secret-reason',
      },
    });

    expect(snapshot.sharedContainersRecipientSurface).toEqual({
      open: false,
      containerTitle: 'x'.repeat(200),
    });
  });

  it('projects a bounded sanitized list of unopened recipient containers', () => {
    const listedContainers = Array.from({ length: 52 }, (_, index) => ({
      containerId: `container-${index}`,
      organizationId: `org-${index}`,
      containerType: index === 1 ? 'COWORK_WORK_ENTRY' : 'CODE_WORKTREE',
      title: index === 0 ? 'x'.repeat(250) : `Container ${index}`,
      transcript: 'must never leave the renderer',
    }));
    listedContainers[2] = {
      ...listedContainers[2],
      containerType: 'UNKNOWN',
    };

    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.recipientSurface': {
        open: false,
        listedContainerCount: listedContainers.length,
        listedContainers,
      },
    });
    const reported = (
      snapshot.sharedContainersRecipientSurface as unknown as {
        listedContainers?: Array<Record<string, unknown>>;
      }
    ).listedContainers;

    expect(reported).toHaveLength(49);
    expect(reported?.[0]).toEqual({
      containerId: 'container-0',
      organizationId: 'org-0',
      containerType: 'CODE_WORKTREE',
      title: 'x'.repeat(200),
    });
    expect(
      reported?.some(({ containerId }) => containerId === 'container-2'),
    ).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('must never');
  });

  it('preserves direct access for a personal recipient container', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.recipientSurface': {
        open: false,
        listedContainerCount: 1,
        listedContainers: [
          {
            containerId: 'personal-container',
            organizationId: null,
            access: 'direct',
            containerType: 'CODE_WORKTREE',
            title: 'Personal share',
          },
        ],
      },
    });

    expect(snapshot.sharedContainersRecipientSurface?.listedContainers).toEqual(
      [
        {
          containerId: 'personal-container',
          access: 'direct',
          containerType: 'CODE_WORKTREE',
          title: 'Personal share',
        },
      ],
    );
  });
});
