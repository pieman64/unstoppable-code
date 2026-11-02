import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { type JSX, type ReactNode } from 'react';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import {
  isOllamaSupportedOnPlatform,
  isVoiceDictationPlatform,
} from '@canopy/desktop-shared/platform-capabilities';
// Canonical declaration of `SettingsSection` lives in `@canopy/desktop-shared`
// so the App Advisor action union (which targets settings sections) and the
// settings UI share a single source of truth. The renderer re-exports the
// alias from this module for backwards-compatible imports.
import type { SettingsSection as SharedSettingsSection } from '@canopy/desktop-shared/types';
import {
  AppAdvisorIcon,
  Bell2Icon,
  BranchIcon,
  BrightnessAutoIcon,
  ChatIcon,
  ClaudeIcon,
  CommandIcon,
  CodeBracketsIcon,
  CodexIcon,
  DocumentIcon,
  ExperimentIcon,
  FileIcon,
  GlobeIcon,
  GraphIcon,
  MacbookIcon,
  McpServerIcon,
  CognitionIcon,
  MicIcon,
  NoteIcon,
  OllamaIcon,
  PlanModeIcon,
  PluginsIcon,
  PrivacyIcon,
  PersonIcon,
  ResourceMonitorIcon,
  SettingsIcon,
  ShieldCheck,
  SkillIcon,
  SyncIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { SIDEBAR_DEFAULT_WIDTH } from '@/stores/sidebarStore';
import { SidebarNavRow } from '@/components/sidebar/SidebarNavRow';
import { SidebarPageNav } from '@/components/sidebar/SidebarPageNav';
import { SidebarPageNavGroup } from '@canopy/ui-app/sidebar';
import { brandText } from '@/lib/brand';
import { localPlatform } from '@/lib/local-platform';

export type SettingsSection = SharedSettingsSection;

interface SettingsNavProps {
  activeSection: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onClose: () => void;
  codeGraphEnabled?: boolean;
  claudeSettingsAvailable?: boolean;
  /** Remote access is available in this window (flag on, local window). */
  remoteAccessEnabled?: boolean;
  width?: number;
  onResize?: (widthPx: number) => void;
  /**
   * Hosted account and organization settings are available (CAN-4386). The
   * rail switches to the hosted layout and this places its local groups
   * around the hosted ones: `appGroup` (General, Privacy, Remote access,
   * Display, labeled with the product name) first, and `trailingGroups`
   * (Agents through Advanced) after them. Absent, the
   * legacy rail renders unchanged.
   */
  renderHostedRail?: (slots: HostedRailSlots) => ReactNode;
  /**
   * Whether a local section is the destination. While a hosted page shows,
   * no local row is selected, so exactly one row is selected in the rail.
   */
  localSelected?: boolean;
}

/** The local groups the hosted rail places around its own groups. */
export interface HostedRailSlots {
  readonly appGroup: ReactNode;
  readonly trailingGroups: ReactNode;
}

interface NavItem {
  key: SettingsSection;
  label: string;
  icon: JSX.Element;
}

interface NavGroup {
  id: string;
  label: string;
  keys: readonly SettingsSection[];
}

const ALL_NAV_ITEMS: NavItem[] = [
  {
    key: 'canopy',
    label: 'General',
    icon: <SettingsIcon width={16} height={16} />,
  },
  {
    key: 'account',
    label: 'Accounts',
    icon: <PersonIcon width={16} height={16} />,
  },
  {
    key: 'privacy',
    label: 'Privacy',
    icon: <PrivacyIcon width={16} height={16} />,
  },
  {
    key: 'remote-access',
    label: 'Remote access',
    // The computer glyph of the sidebar machine picker, so both surfaces
    // read as one feature.
    icon: <MacbookIcon width={16} height={16} />,
  },
  {
    key: 'performance',
    label: 'Performance',
    icon: <ResourceMonitorIcon width={16} height={16} />,
  },
  {
    key: 'code-graph',
    label: 'Code Graph',
    // Same glyph as the code graph tool blocks in chat, so the settings page
    // reads as part of that family.
    icon: <GraphIcon width={16} height={16} />,
  },
  {
    key: 'experiments',
    label: 'Labs',
    icon: <ExperimentIcon width={16} height={16} />,
  },
  {
    key: 'shortcuts',
    label: 'Shortcuts',
    icon: <CommandIcon width={16} height={16} />,
  },
  {
    key: 'display',
    label: 'Display',
    icon: <BrightnessAutoIcon width={16} height={16} />,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: <Bell2Icon width={16} height={16} />,
  },
  {
    key: 'mcp',
    label: 'MCP servers',
    icon: <McpServerIcon width={16} height={16} />,
  },
  {
    key: 'approvals',
    label: 'Approvals',
    icon: <ShieldCheck width={16} height={16} />,
  },
  {
    key: 'chat',
    label: 'Models',
    icon: <ChatIcon width={16} height={16} />,
  },
  {
    key: 'instructions',
    label: 'Instructions',
    icon: <NoteIcon width={16} height={16} />,
  },
  {
    key: 'memory',
    label: 'Memory',
    icon: <CognitionIcon width={16} height={16} />,
  },
  {
    key: 'harnesses',
    label: 'Default harness',
    icon: <SyncIcon width={16} height={16} />,
  },
  {
    key: 'plugins',
    label: 'Plugins',
    icon: <PluginsIcon width={16} height={16} />,
  },
  {
    key: 'app-advisor',
    label: ORCHESTRATOR_LABEL,
    icon: <AppAdvisorIcon width={16} height={16} />,
  },
  {
    key: 'files',
    label: 'Files',
    icon: <FileIcon width={16} height={16} />,
  },
  {
    key: 'browser',
    label: 'Browser',
    icon: <GlobeIcon width={16} height={16} />,
  },
  {
    key: 'terminal',
    label: 'Terminal',
    icon: <TerminalBorderedIcon width={16} height={16} />,
  },
  {
    key: 'environment',
    label: 'Environments',
    icon: <CodeBracketsIcon width={16} height={16} />,
  },
  {
    key: 'plan-detection',
    label: 'Plan detection',
    icon: <PlanModeIcon width={16} height={16} />,
  },
  {
    key: 'dictation',
    label: 'Dictation',
    icon: <MicIcon width={16} height={16} />,
  },
  {
    key: 'codex',
    label: 'Codex',
    icon: <CodexIcon width={16} height={16} />,
  },
  {
    key: 'claude',
    label: 'Claude',
    icon: <ClaudeIcon width={16} height={16} />,
  },
  {
    key: 'ollama',
    label: 'Ollama',
    icon: <OllamaIcon width={16} height={16} />,
  },
  {
    key: 'account-proxy',
    label: 'Multi-account proxy',
    icon: <GlobeIcon width={16} height={16} />,
  },
  {
    key: 'git',
    label: 'Git',
    icon: <BranchIcon width={16} height={16} />,
  },
  {
    key: 'applications',
    label: 'Applications',
    icon: <SkillIcon width={16} height={16} />,
  },
  {
    key: 'legal',
    label: 'Legal',
    icon: <DocumentIcon width={16} height={16} />,
  },
];

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'personal',
    label: 'Personal',
    keys: [
      'canopy',
      'account',
      'account-proxy',
      'privacy',
      'remote-access',
      'display',
      'notifications',
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    keys: [
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'approvals',
      'app-advisor',
      'codex',
      'claude',
      'ollama',
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keys: [
      'git',
      'plugins',
      'mcp',
      'files',
      'browser',
      'terminal',
      'environment',
      'applications',
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    keys: ['shortcuts', 'dictation', 'plan-detection'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    keys: ['performance', 'code-graph', 'experiments', 'legal'],
  },
];

/**
 * The local groups when hosted account settings are available. The app
 * group, labeled with the product name, leads the rail; the hosted Account
 * and Organizations groups sit between it and Agents. Cloud account, GitHub and Linear moved to hosted Account
 * and Integrations, so `account` keeps only the LLM providers and joins
 * Agents as "Providers". `notifications` is omitted on purpose: hosted
 * Notifications carries its rows, and the overlay aliases requests for it.
 */
const HOSTED_APP_NAV_GROUP: NavGroup = {
  id: 'personal',
  label: brandText.appName,
  keys: ['canopy', 'privacy', 'remote-access', 'display'],
};

const HOSTED_TRAILING_NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'agents',
    label: 'Agents',
    keys: [
      'account',
      'account-proxy',
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'approvals',
      'app-advisor',
      'codex',
      'claude',
      'ollama',
    ],
  },
  {
    id: 'integrations',
    label: 'Tools',
    keys: [
      'git',
      'plugins',
      'mcp',
      'files',
      'browser',
      'terminal',
      'environment',
      'applications',
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    keys: ['shortcuts', 'dictation', 'plan-detection'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    keys: ['performance', 'code-graph', 'experiments', 'legal'],
  },
];

const HOSTED_NAV_GROUPS: readonly NavGroup[] = [
  HOSTED_APP_NAV_GROUP,
  ...HOSTED_TRAILING_NAV_GROUPS,
];

/** Sections the hosted layout leaves out of the rail (reached by alias). */
const HOSTED_NAV_OMITTED_SECTIONS: ReadonlySet<SettingsSection> =
  new Set<SettingsSection>(['notifications']);

/** Row labels that differ in the hosted layout; key and icon stay. */
const HOSTED_NAV_LABELS: Partial<Record<SettingsSection, string>> = {
  account: 'Providers',
};

const NAV_ITEM_ORDER: readonly SettingsSection[] = NAV_GROUPS.flatMap(
  (group) => group.keys,
);

const HOSTED_NAV_ITEM_ORDER: readonly SettingsSection[] =
  HOSTED_NAV_GROUPS.flatMap((group) => group.keys);

const NAV_ITEMS_BY_KEY = new Map<SettingsSection, NavItem>(
  ALL_NAV_ITEMS.map((item) => [item.key, item]),
);

function getOrderedNavItems(): NavItem[] {
  const orderedKeys = new Set<SettingsSection>(NAV_ITEM_ORDER);
  const unorderedItemKeys = ALL_NAV_ITEMS.filter(
    (item) => !orderedKeys.has(item.key),
  ).map((item) => item.key);
  if (unorderedItemKeys.length > 0) {
    throw new Error(
      `Missing settings nav order for ${unorderedItemKeys.join(', ')}`,
    );
  }

  return NAV_ITEM_ORDER.map((key) => {
    const item = NAV_ITEMS_BY_KEY.get(key);
    if (!item) {
      throw new Error(`Missing settings nav item for ${key}`);
    }
    return item;
  });
}

/**
 * The hosted layout's items, in its order and with its labels. Every legacy
 * section must appear here unless it is deliberately omitted, so a new
 * section cannot silently drop out of the hosted rail.
 */
function getHostedOrderedNavItems(): NavItem[] {
  const legacyItems = getOrderedNavItems();
  const hostedKeys = new Set<SettingsSection>(HOSTED_NAV_ITEM_ORDER);
  const missingKeys = legacyItems
    .filter(
      (item) =>
        !hostedKeys.has(item.key) && !HOSTED_NAV_OMITTED_SECTIONS.has(item.key),
    )
    .map((item) => item.key);
  if (missingKeys.length > 0) {
    throw new Error(
      `Missing hosted settings nav order for ${missingKeys.join(', ')}`,
    );
  }

  return HOSTED_NAV_ITEM_ORDER.map((key) => {
    const item = NAV_ITEMS_BY_KEY.get(key);
    if (!item) {
      throw new Error(`Missing settings nav item for ${key}`);
    }
    const label = HOSTED_NAV_LABELS[key];
    return label === undefined ? item : { ...item, label };
  });
}

export interface VisibleNavItemsOptions {
  /** Hosted account settings are available: use the hosted layout. */
  readonly hostedLayout?: boolean;
}

// Exported for platform-specific settings navigation tests.
// eslint-disable-next-line react-refresh/only-export-components
export function getVisibleNavItems(
  platform: NodeJS.Platform,
  claudeSettingsAvailable = true,
  codeGraphEnabled = true,
  accountProxyAvailable = false,
  remoteAccessEnabled = false,
  options: VisibleNavItemsOptions = {},
): NavItem[] {
  const orderedItems =
    options.hostedLayout === true
      ? getHostedOrderedNavItems()
      : getOrderedNavItems();
  return orderedItems.filter((item) => {
    if (item.key === 'code-graph') return codeGraphEnabled;
    // The flag and the Experiments opt-in must both be on (CAN-4019).
    if (item.key === 'account-proxy') return accountProxyAvailable;
    if (item.key === 'remote-access') return remoteAccessEnabled;
    if (item.key === 'dictation') {
      return isVoiceDictationPlatform(platform);
    }
    // Ollama visibility flows through the shared platform-support predicate so
    // renderer, preload, and main agree. Visible on macOS and Windows; hidden
    // on unsupported desktop platforms.
    if (item.key === 'ollama') {
      return isOllamaSupportedOnPlatform();
    }
    if (item.key === 'claude') {
      return claudeSettingsAvailable;
    }
    return true;
  });
}

export function SettingsNav({
  activeSection,
  onNavigate,
  onClose,
  codeGraphEnabled = true,
  claudeSettingsAvailable = true,
  remoteAccessEnabled = false,
  width = SIDEBAR_DEFAULT_WIDTH,
  onResize,
  renderHostedRail,
  localSelected = true,
}: SettingsNavProps): JSX.Element {
  const accountProxyAvailable = useAccountProxyStatus()?.available === true;
  const hostedLayout = renderHostedRail !== undefined;
  // Its only platform gate is dictation, which runs on this computer.
  const navItems = getVisibleNavItems(
    localPlatform(),
    claudeSettingsAvailable,
    codeGraphEnabled,
    accountProxyAvailable,
    remoteAccessEnabled,
    { hostedLayout },
  );
  const visibleNavItems = new Map(
    navItems.map((item) => [item.key, item] as const),
  );
  const renderGroup = (group: NavGroup): JSX.Element | null => {
    const groupItems = group.keys.flatMap((key) => {
      const item = visibleNavItems.get(key);
      return item ? [item] : [];
    });
    if (groupItems.length === 0) {
      return null;
    }

    return (
      <SidebarPageNavGroup
        key={group.label}
        label={group.label}
        testId={`settings-nav-group-${group.id}`}
      >
        {groupItems.map((item) => (
          <SidebarNavRow
            key={item.key}
            onClick={() => onNavigate(item.key)}
            data-testid={`settings-nav-${item.key}`}
            className="text-left"
            selected={localSelected && activeSection === item.key}
            icon={item.icon}
          >
            {item.label}
          </SidebarNavRow>
        ))}
      </SidebarPageNavGroup>
    );
  };
  const groups =
    renderHostedRail === undefined
      ? NAV_GROUPS.map(renderGroup)
      : renderHostedRail({
          appGroup: renderGroup(HOSTED_APP_NAV_GROUP),
          trailingGroups: HOSTED_TRAILING_NAV_GROUPS.map(renderGroup),
        });
  return (
    <SidebarPageNav
      ariaLabel="Settings"
      sidebarTestId="settings-sidebar"
      backTestId="settings-nav-back"
      resizeHandleTestId="settings-sidebar-resize-handle"
      scrollViewportTestId="settings-nav-scroll-container"
      onBack={onClose}
      width={width}
      onResize={onResize}
    >
      <nav className="flex flex-col">{groups}</nav>
    </SidebarPageNav>
  );
}
