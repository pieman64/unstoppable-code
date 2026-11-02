import { buildOrganizationOptions } from '@canopy/ui-app';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import {
  type SidebarItem,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import {
  COMMAND_DEFINITIONS,
  dispatchOpenWorktreeSettingsEvent,
  type CommandDefinition,
  type CommandId,
} from '@/lib/keyboardShortcuts';
import type { PanelLayoutViewModel } from '@canopy/ui-shared/panels';
import {
  getPaletteCommandAvailability,
  getPaletteCommandUnavailableMessage,
  isPaletteCommandAvailable,
} from './paletteAvailability';
import { openCurrentWorktreePr } from '@/components/pr-picker/openCurrentPr';
import { isCoworkChatTarget } from '@/lib/cowork';
import { openLedgerPanel } from '@/lib/ledger/open-ledger-panel';
import {
  openCostPanel,
  openSessionBreakdownPanel,
} from '@/lib/cost/open-cost-panels';
import { PANEL_COMMANDS, runPanelCommand } from '@/lib/panels/commands';
import { useActivityStore } from '@/stores/activityStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { isPageAvailable } from '@/lib/navigation/page-availability';
import { useProjectsStore } from '@/stores/projectsStore';
import type { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';

export interface CommandExecutionResult {
  closePalette: boolean;
  error?: string;
}

export interface PaletteCommand extends CommandDefinition {
  commandKey: string;
  priority: number;
  /** The title and subtitle name a project, so session replay masks them. */
  namesProject?: boolean;
  execute: () => Promise<CommandExecutionResult> | CommandExecutionResult;
}

const PALETTE_COMMAND_IDS: CommandId[] = [
  'open-file-search-palette',
  'new-task',
  'new-worktree-current-context',
  'new-chat-tab',
  'close-chat-tab',
  'open-app-advisor',
  'open-app-advisor-quick-prompt',
  'open-settings',
  'open-shortcuts-settings',
  'open-environment-settings',
  'open-current-pr',
  'open-ledger-panel',
  'open-cost-panel',
  'open-session-breakdown',
  'navigate-overview',
  'navigate-worktrees',
  'navigate-chat',
  'navigate-pipelines',
  'navigate-automations',
  'navigate-feed',
  'navigate-plugins',
  'navigate-audit',
  'navigate-statistics',
  'navigate-usage',
  'toggle-activity-panel',
  'refresh-worktree-status',
  'open-worktree-scripts',
  'open-worktree-hooks',
];

function getCommandPriority(commandKey: string): number {
  if (
    commandKey === 'open-file-search-palette' ||
    commandKey === 'new-worktree-current-context' ||
    commandKey === 'new-chat-tab' ||
    commandKey === 'close-chat-tab' ||
    commandKey === 'open-app-advisor' ||
    commandKey === 'open-app-advisor-quick-prompt' ||
    commandKey === 'open-settings' ||
    commandKey === 'open-shortcuts-settings' ||
    commandKey === 'open-current-pr'
  ) {
    return 0;
  }

  if (commandKey.startsWith('new-worktree-project-')) {
    return 1;
  }

  if (commandKey.startsWith('navigate-')) {
    return 2;
  }

  return 3;
}

function isValidWorktreeProject(project: SidebarItem): boolean {
  return project.type !== 'multi-repo' || project.repos.length > 0;
}

export function comparePaletteCommands(
  left: PaletteCommand,
  right: PaletteCommand,
): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  return left.title.localeCompare(right.title);
}

function getSelectedWorktreeKey(
  selectedWorktree: { projectId: string; worktreeId: string } | null,
): string | null {
  if (!selectedWorktree) {
    return null;
  }

  return `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
}

export function buildProjectCommands(
  projects: SidebarItem[],
): PaletteCommand[] {
  const validProjects = projects.filter((project) =>
    isValidWorktreeProject(project),
  );

  return validProjects.map((project) => ({
    id: 'new-worktree',
    commandKey: `new-worktree-project-${project.id}`,
    title: `New Worktree in ${project.name}`,
    subtitle: `Create from ${project.name}`,
    namesProject: true,
    category: 'worktrees',
    keywords: [
      'new',
      'worktree',
      'workspace',
      project.name,
      project.id,
      'create',
    ],
    priority: getCommandPriority(`new-worktree-project-${project.id}`),
    execute: async (): Promise<CommandExecutionResult> => {
      const created = await useProjectsStore
        .getState()
        .createWorktree(project.id, {
          onRegistered: () => useNavigationStore.getState().navigate('main'),
        });
      if (!created) {
        return {
          closePalette: false,
          error:
            'Unable to create worktree. Please review worktree errors and retry.',
        };
      }
      return { closePalette: true };
    },
  }));
}

/**
 * Panel-grid operations for the selected worktree's layout (doc 12 §1). The
 * op/availability layer is `lib/panels/commands.ts`; this adapter surfaces
 * the currently-available subset as palette commands. `panelViewModel` is the
 * palette's reactive layout snapshot so the listing tracks grid changes;
 * execution re-validates against fresh store state via `runPanelCommand`.
 */
export function buildPanelCommands(
  selectedWorktree: { projectId: string; worktreeId: string } | null,
  panelViewModel: PanelLayoutViewModel | null,
): PaletteCommand[] {
  if (
    !selectedWorktree ||
    isCoworkChatTarget(selectedWorktree.projectId) ||
    panelViewModel === null
  ) {
    return [];
  }

  const worktreeKey = makeWorktreePanelKey(
    selectedWorktree.projectId,
    selectedWorktree.worktreeId,
  );
  return PANEL_COMMANDS.filter((command) =>
    command.isAvailable(panelViewModel, worktreeKey),
  ).flatMap((command) => {
    const definition = COMMAND_DEFINITIONS.find(
      (entry) => entry.id === command.id,
    );
    if (!definition) {
      return [];
    }

    return [
      {
        ...definition,
        commandKey: definition.id,
        priority: getCommandPriority(definition.id),
        execute: (): CommandExecutionResult => {
          const navigation = useNavigationStore.getState();
          const latestSelection = useChatStore.getState().selectedWorktree;
          if (
            !latestSelection ||
            isCoworkChatTarget(latestSelection.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }

          // Panel ops act on the grid inside the always-mounted MainPage;
          // navigate there so the result is visible (same pattern as the
          // worktree scripts/hooks commands).
          navigation.navigate('main');
          const ran = runPanelCommand(
            command.id,
            makeWorktreePanelKey(
              latestSelection.projectId,
              latestSelection.worktreeId,
            ),
          );
          if (!ran) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          return { closePalette: true };
        },
      },
    ];
  });
}

/**
 * Personal/organization context switches (CAN-2953). One command per
 * membership, minted from the main-owned context state; none while the
 * org-projects flag is off or the account has no organizations, matching the
 * sidebar picker's visibility rule.
 */
export function buildContextSwitchCommands(
  enabled: boolean,
  {
    context,
    organizations,
  }: Pick<WorkspaceContextState, 'context' | 'organizations'>,
  setContext: ReturnType<
    typeof useWorkspaceContextStore.getState
  >['setContext'],
): PaletteCommand[] {
  if (!enabled) {
    return [];
  }
  if (organizations.length === 0) {
    return [];
  }
  const switchTo = (
    target: Parameters<
      ReturnType<typeof useWorkspaceContextStore.getState>['setContext']
    >[0],
  ): Promise<CommandExecutionResult> =>
    setContext(target)
      .then((): CommandExecutionResult => ({ closePalette: true }))
      .catch(
        (): CommandExecutionResult => ({
          closePalette: false,
          error: "Couldn't switch context. Try again.",
        }),
      );
  const personal: PaletteCommand = {
    id: 'switch-context-personal',
    commandKey: 'switch-context-personal',
    title: 'Switch to Personal',
    subtitle: context.kind === 'personal' ? 'Current context' : undefined,
    category: 'navigation',
    keywords: ['context', 'personal', 'organization', 'switch'],
    priority: 2,
    execute: () => switchTo({ kind: 'personal' }),
  };
  return [
    personal,
    ...buildOrganizationOptions(organizations).map(
      ({ organization, secondary }): PaletteCommand => ({
        id: 'switch-context-organization',
        commandKey: `switch-context-${organization.id}`,
        title: `Switch to ${organization.name}${secondary ? ` ${secondary}` : ''}`,
        subtitle:
          context.kind === 'organization' &&
          context.organizationId === organization.id
            ? 'Current context'
            : undefined,
        category: 'navigation',
        keywords: ['context', 'organization', 'switch', organization.name],
        priority: 2,
        execute: () =>
          switchTo({ kind: 'organization', organizationId: organization.id }),
      }),
    ),
  ];
}

/**
 * The selected context's organization pages inside Settings: Personal gets
 * its Timeline and Statistics; an organization gets its Timeline, Statistics
 * (owners and admins, as on the context switcher), Members and Settings. None
 * while hosted settings are off or the context is not known yet.
 */
export function buildOrganizationPageCommands(
  enabled: boolean,
  {
    context,
    organizations,
  }: Pick<WorkspaceContextState, 'context' | 'organizations'>,
  personalOrganizationId: string | null,
): PaletteCommand[] {
  if (!enabled) return [];
  type OrganizationPage = 'feed' | 'statistics' | 'members' | 'settings';
  const PAGE_LABELS: Record<OrganizationPage, string> = {
    feed: 'Timeline',
    statistics: 'Statistics',
    members: 'Members',
    settings: 'Settings',
  };
  const command = (
    organizationId: string,
    name: string,
    page: OrganizationPage,
    namesOrganization: boolean,
  ): PaletteCommand => {
    const route: SettingsRoute = {
      scope: 'organization',
      organizationId,
      page,
    };
    return {
      id: 'open-organization-page',
      commandKey: `open-organization-${page}-${organizationId}`,
      title: `Open ${name} ${PAGE_LABELS[page]}`,
      namesProject: namesOrganization,
      category: 'navigation',
      // The Timeline was called Feed, so that word still finds it.
      keywords: [
        'organization',
        name,
        PAGE_LABELS[page],
        ...(page === 'feed' ? ['feed'] : []),
      ],
      priority: 2,
      execute: (): CommandExecutionResult => {
        openAccountOrganizationPage(route);
        return { closePalette: true };
      },
    };
  };
  if (context.kind === 'personal') {
    const id = normalizePersonalOrganizationId(personalOrganizationId);
    if (id === null) return [];
    return [
      command(id, 'Personal', 'feed', false),
      command(id, 'Personal', 'statistics', false),
    ];
  }
  const organization = organizations.find(
    (entry) => entry.id === context.organizationId,
  );
  if (!organization) return [];
  const pages: OrganizationPage[] =
    organization.role === 'OWNER' || organization.role === 'ADMIN'
      ? ['feed', 'statistics', 'members', 'settings']
      : ['feed', 'members', 'settings'];
  return pages.map((page) =>
    command(organization.id, organization.name, page, true),
  );
}

/** Commands that open a page owned by a Labs page experiment (CAN-3678). */
const LABS_PAGE_COMMAND_IDS: ReadonlySet<string> = new Set([
  'navigate-overview',
  'navigate-audit',
  'navigate-statistics',
]);

/**
 * The Labs page commands read the page availability policy directly; a
 * mounted palette rebuilds when their availability changes.
 */
export function buildBaseCommands(
  selectedWorktree: { projectId: string; worktreeId: string } | null,
): PaletteCommand[] {
  const availability = getPaletteCommandAvailability(
    selectedWorktree,
    getSelectedWorktreeKey(selectedWorktree),
  );

  const baseCommands: PaletteCommand[] = COMMAND_DEFINITIONS.filter(
    (definition) => {
      if (
        LABS_PAGE_COMMAND_IDS.has(definition.id) &&
        definition.page !== undefined &&
        !isPageAvailable(definition.page)
      ) {
        return false;
      }
      // The Ledger panel and Feed follow the Feed page's availability: both
      // need the Ledger on.
      if (
        (definition.id === 'open-ledger-panel' ||
          definition.id === 'navigate-feed') &&
        !isPageAvailable('feed')
      ) {
        return false;
      }
      return isPaletteCommandAvailable(
        definition,
        availability,
        PALETTE_COMMAND_IDS,
      );
    },
  ).map((definition) => ({
    ...definition,
    commandKey: definition.id,
    priority: getCommandPriority(definition.id),
    execute: async (): Promise<CommandExecutionResult> => {
      const navigation = useNavigationStore.getState();
      const chat = useChatStore.getState();
      const projects = useProjectsStore.getState();
      const activity = useActivityStore.getState();
      const latestSelectedWorktree = chat.selectedWorktree;
      const selectedWorktreeKey = getSelectedWorktreeKey(
        latestSelectedWorktree,
      );
      const latestActiveTabId = selectedWorktreeKey
        ? chat.worktreeChats[selectedWorktreeKey]?.activeTabId
        : undefined;

      switch (definition.id) {
        case 'navigate-overview':
        case 'navigate-worktrees':
        case 'navigate-chat':
        case 'navigate-pipelines':
        case 'navigate-automations':
        case 'navigate-feed':
        case 'navigate-plugins':
        case 'navigate-audit':
        case 'navigate-statistics':
        case 'navigate-usage':
          if (definition.page) {
            navigation.navigate(definition.page);
          }
          return { closePalette: true };
        case 'open-file-search-palette':
          if (!latestSelectedWorktree) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          // Cowork work entries have the same indexed-file search as code
          // worktrees; they just live on the chat page.
          navigation.navigate(
            isCoworkChatTarget(latestSelectedWorktree.projectId)
              ? 'chat'
              : 'main',
          );
          navigation.openFileSearchPalette();
          return { closePalette: true };
        case 'open-settings':
          navigation.openSettings();
          return { closePalette: true };
        case 'open-shortcuts-settings':
          navigation.openSettings('shortcuts');
          return { closePalette: true };
        case 'open-environment-settings':
          navigation.openSettings('environment');
          return { closePalette: true };
        case 'open-ledger-panel': {
          if (!latestSelectedWorktree) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          navigation.navigate(
            isCoworkChatTarget(latestSelectedWorktree.projectId)
              ? 'chat'
              : 'main',
          );
          return openLedgerPanel(
            latestSelectedWorktree.projectId,
            latestSelectedWorktree.worktreeId,
          )
            ? { closePalette: true }
            : {
                closePalette: false,
                error: getPaletteCommandUnavailableMessage(definition.id),
              };
        }
        case 'open-cost-panel': {
          if (!latestSelectedWorktree) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          navigation.navigate(
            isCoworkChatTarget(latestSelectedWorktree.projectId)
              ? 'chat'
              : 'main',
          );
          const result = await openCostPanel({
            projectId: latestSelectedWorktree.projectId,
            worktreeId: latestSelectedWorktree.worktreeId,
          });
          return result.status === 'placed' || result.status === 'revealed'
            ? { closePalette: true }
            : {
                closePalette: false,
                error: getPaletteCommandUnavailableMessage(definition.id),
              };
        }
        case 'open-session-breakdown': {
          const activeTab =
            latestSelectedWorktree && selectedWorktreeKey
              ? chat.worktreeChats[selectedWorktreeKey]?.tabs.find(
                  (tab) => tab.id === latestActiveTabId,
                )
              : undefined;
          if (
            !latestSelectedWorktree ||
            !latestActiveTabId ||
            activeTab === undefined ||
            activeTab.kind === 'file'
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          navigation.navigate(
            isCoworkChatTarget(latestSelectedWorktree.projectId)
              ? 'chat'
              : 'main',
          );
          const result = await openSessionBreakdownPanel(
            {
              projectId: latestSelectedWorktree.projectId,
              worktreeId: latestSelectedWorktree.worktreeId,
            },
            latestActiveTabId,
          );
          return result.status === 'placed' || result.status === 'revealed'
            ? { closePalette: true }
            : {
                closePalette: false,
                error: getPaletteCommandUnavailableMessage(definition.id),
              };
        }
        case 'open-current-pr': {
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          const result = openCurrentWorktreePr();
          if (result.kind === 'no-prs') {
            return {
              closePalette: false,
              error: 'No pull request found for this worktree.',
            };
          }
          return { closePalette: true };
        }
        case 'new-task':
          navigation.navigate('home');
          return { closePalette: true };
        case 'new-chat-tab':
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          navigation.navigate('main');
          chat.createTab();
          return { closePalette: true };
        case 'close-chat-tab':
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId) ||
            !latestActiveTabId
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          chat.closeTab(latestActiveTabId);
          return { closePalette: true };
        case 'open-app-advisor':
          useAppAdvisorStore.getState().openDialog();
          return { closePalette: true };
        case 'open-app-advisor-quick-prompt':
          navigation.openAppAdvisorQuickPrompt();
          return { closePalette: true };
        case 'new-worktree-current-context':
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          {
            const created = await projects.createWorktree(
              latestSelectedWorktree.projectId,
            );
            if (!created) {
              return {
                closePalette: false,
                error:
                  'Unable to create worktree. Please review worktree errors and retry.',
              };
            }
          }
          return { closePalette: true };
        case 'toggle-activity-panel':
          activity.setPanelExpanded(!activity.panelExpanded);
          return { closePalette: true };
        case 'refresh-worktree-status':
          await projects.refreshDiffStats();
          return { closePalette: true };
        case 'open-worktree-scripts':
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          // Navigate to main first so the worktree settings modal (rendered
          // inside the always-mounted MainPage subtree) becomes visible.
          navigation.navigate('main');
          dispatchOpenWorktreeSettingsEvent('scripts');
          return { closePalette: true };
        case 'open-worktree-hooks':
          if (
            !latestSelectedWorktree ||
            isCoworkChatTarget(latestSelectedWorktree.projectId)
          ) {
            return {
              closePalette: false,
              error: getPaletteCommandUnavailableMessage(definition.id),
            };
          }
          // Navigate to main first so the worktree settings modal (rendered
          // inside the always-mounted MainPage subtree) becomes visible.
          navigation.navigate('main');
          dispatchOpenWorktreeSettingsEvent('hooks');
          return { closePalette: true };
        default:
          return {
            closePalette: false,
            error: getPaletteCommandUnavailableMessage(definition.id),
          };
      }
    },
  }));
  return baseCommands;
}
