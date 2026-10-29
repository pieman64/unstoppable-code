import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type {
  ResourceGroupId,
  ResourceMonitorSnapshot,
  ResourceProcessSnapshot,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { CHAT_LABEL } from '@canopy/protocol';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { formatCpuPercent, formatMemoryBytes } from './format';
import {
  getResourceDiagnosticsSortState,
  setResourceDiagnosticsSortState,
  type ResourceDiagnosticsSortColumn,
  type ResourceDiagnosticsSortState,
} from './sortState';
import {
  DropdownMenuSurface,
  OverlayScrollArea,
  RailIconButton,
} from '@canopy/ui-shared';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import {
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChipSimpleIcon,
  GlobeIcon,
  PlayIcon,
  SettingsIcon,
  TerminalIcon,
  WorkflowIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { BrandLogo } from '@/components/BrandLogo';

interface ResourceDiagnosticsPopoverProps {
  snapshot: ResourceMonitorSnapshot | null;
  error: string | null;
  onClose: () => void;
  loading?: boolean;
  /** Ref to the panel element, used by the caller to anchor and size it. */
  panelRef?: RefObject<HTMLDivElement | null>;
  /** Positioning supplied by the caller; the panel does not position itself. */
  style?: CSSProperties;
  /** Whether the caller has placed the panel; starts the entry motion. */
  positioned?: boolean;
}

const GROUP_LABELS: Record<ResourceGroupId, string> = {
  app: 'App',
  browser: 'Browser',
  codex: 'Codex',
  claude: 'Claude',
  chat: CHAT_LABEL,
  pipelines: 'Pipelines',
  terminal: 'Terminal',
  scripts: 'Script',
  other: 'Other',
};

const GROUP_PRIORITY: Record<ResourceGroupId, number> = {
  app: 0,
  browser: 1,
  pipelines: 2,
  codex: 3,
  claude: 4,
  chat: 5,
  terminal: 6,
  scripts: 7,
  other: 8,
};

const ELECTRON_PROCESS_LABEL_PREFIX = 'Electron ';

const SOURCE_ICON_SIZE = 12;

function AppSourceIcon(): JSX.Element {
  return <BrandLogo size={SOURCE_ICON_SIZE} aria-hidden />;
}

const SOURCE_ICONS: Record<
  ResourceGroupId,
  ComponentType<{ width?: number; height?: number }>
> = {
  app: AppSourceIcon,
  browser: GlobeIcon,
  codex: CodexLogo,
  claude: ClaudeLogo,
  chat: ChatIcon,
  pipelines: WorkflowIcon,
  terminal: TerminalIcon,
  scripts: PlayIcon,
  other: ChipSimpleIcon,
};

/**
 * Sources whose processes the app runs for itself (Electron and the commands
 * it spawns, such as git), as opposed to agents, scripts, terminals, and
 * browser tabs it runs on someone's behalf.
 */
const APP_MANAGED_GROUPS: ReadonlySet<ResourceGroupId> =
  new Set<ResourceGroupId>(['app', 'other']);

interface FlattenedRow {
  id: string;
  groupId: ResourceGroupId;
  groupLabel: string;
  process: ResourceProcessSnapshot;
  secondaryText: string | null;
  navigationTarget: WorktreeNavigationTarget | null;
  attributionLabel: string | null;
  depth: number;
  hasChildren: boolean;
}

interface WorktreeNavigationTarget {
  projectId: string;
  worktreeId: string;
}

interface WorktreeAttribution extends WorktreeNavigationTarget {
  label: string;
  navigable: boolean;
}

interface ResourceDiagnosticsContext {
  projects: SidebarItem[];
  hasHydratedProjects: boolean;
}

interface InheritedRowContext {
  attributionLabel: string | null;
  navigationTarget: WorktreeNavigationTarget | null;
}

interface ResourceRowDetails extends InheritedRowContext {
  secondaryText: string | null;
}

function getProcessPathSegment(process: ResourceProcessSnapshot): string {
  if (typeof process.pid === 'number' && process.pid > 0) {
    return `${process.id}:pid:${process.pid}`;
  }
  return process.id;
}

function compareByGroupPriority(
  a: Pick<FlattenedRow, 'groupId'>,
  b: Pick<FlattenedRow, 'groupId'>,
): number {
  return GROUP_PRIORITY[a.groupId] - GROUP_PRIORITY[b.groupId];
}

function compareByGroupThenName(
  a: Pick<FlattenedRow, 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'groupId' | 'process'>,
): number {
  const priorityDelta = compareByGroupPriority(a, b);
  if (priorityDelta !== 0) return priorityDelta;
  return getProcessDisplayLabel(a.process).localeCompare(
    getProcessDisplayLabel(b.process),
  );
}

function compareByGroupNameThenId(
  a: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
): number {
  const primary = compareByGroupThenName(a, b);
  if (primary !== 0) return primary;
  return a.id.localeCompare(b.id);
}

function compareNumeric(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareRows(
  a: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  sort: ResourceDiagnosticsSortState,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.column === 'name') {
    const groupDelta = compareByGroupPriority(a, b);
    if (groupDelta !== 0) return groupDelta;
    const nameDelta = getProcessDisplayLabel(a.process).localeCompare(
      getProcessDisplayLabel(b.process),
    );
    if (nameDelta !== 0) return sign * nameDelta;
    // Fallback: Memory desc.
    const memoryDelta = compareNumeric(
      b.process.memoryRssBytes,
      a.process.memoryRssBytes,
    );
    if (memoryDelta !== 0) return memoryDelta;
    return a.id.localeCompare(b.id);
  }

  const primary =
    sort.column === 'cpu'
      ? compareNumeric(a.process.cpuPercent, b.process.cpuPercent)
      : compareNumeric(a.process.memoryRssBytes, b.process.memoryRssBytes);
  if (primary !== 0) return sign * primary;
  // Fallback: Name/type asc.
  return compareByGroupNameThenId(a, b);
}

function shouldRenderProcess(process: ResourceProcessSnapshot): boolean {
  return !(
    process.kind === 'codex-app-server-pool' && typeof process.pid !== 'number'
  );
}

function getProcessDisplayLabel(process: ResourceProcessSnapshot): string {
  if (
    process.groupId !== 'app' ||
    !process.label.startsWith(ELECTRON_PROCESS_LABEL_PREFIX)
  ) {
    return process.label;
  }
  const stripped = process.label.slice(ELECTRON_PROCESS_LABEL_PREFIX.length);
  if (stripped.length === 0) {
    return process.label;
  }
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Unregistered processes arrive as flat roots. Nests each under the root that
 * spawned it, so an agent's shells and commands roll up under the agent, and
 * gives a parent its subtree's usage the way registered rows already carry.
 * Electron processes never adopt: what they spawn is its own source.
 */
function adoptChildProcesses(
  items: ResourceProcessSnapshot[],
): ResourceProcessSnapshot[] {
  const parentsByPid = new Map<number, ResourceProcessSnapshot>();
  for (const item of items) {
    if (typeof item.pid === 'number' && item.groupId !== 'app') {
      parentsByPid.set(item.pid, item);
    }
  }
  const adopted = new Map<ResourceProcessSnapshot, ResourceProcessSnapshot[]>();
  const roots: ResourceProcessSnapshot[] = [];
  for (const item of items) {
    const parent =
      item.metadata?.type === 'generic' && typeof item.ppid === 'number'
        ? parentsByPid.get(item.ppid)
        : undefined;
    if (parent && parent !== item) {
      adopted.set(parent, [...(adopted.get(parent) ?? []), item]);
    } else {
      roots.push(item);
    }
  }
  const withChildren = (
    item: ResourceProcessSnapshot,
  ): ResourceProcessSnapshot => {
    const children = (adopted.get(item) ?? []).map(withChildren);
    if (children.length === 0) return item;
    return {
      ...item,
      cpuPercent: children.reduce(
        (total, child) => total + child.cpuPercent,
        item.cpuPercent,
      ),
      memoryRssBytes: children.reduce(
        (total, child) => total + child.memoryRssBytes,
        item.memoryRssBytes,
      ),
      processCount: children.reduce(
        (total, child) => total + child.processCount,
        item.processCount,
      ),
      children: [...(item.children ?? []), ...children],
    };
  };
  return roots.map(withChildren);
}

function getRootProcesses(
  snapshot: ResourceMonitorSnapshot,
): ResourceProcessSnapshot[] {
  return adoptChildProcesses(
    snapshot.groups.flatMap((group) =>
      group.items
        .filter(shouldRenderProcess)
        // Rows take the group they were reported in, whatever the item says.
        .map((item) =>
          item.groupId === group.id ? item : { ...item, groupId: group.id },
        ),
    ),
  );
}

function getAppManagedTotals(roots: ResourceProcessSnapshot[]): {
  cpuPercent: number;
  memoryRssBytes: number;
} {
  const appRoots = roots.filter((root) => APP_MANAGED_GROUPS.has(root.groupId));
  return {
    cpuPercent: appRoots.reduce((total, root) => total + root.cpuPercent, 0),
    memoryRssBytes: appRoots.reduce(
      (total, root) => total + root.memoryRssBytes,
      0,
    ),
  };
}

function flattenRows(
  roots: ResourceProcessSnapshot[],
  sort: ResourceDiagnosticsSortState,
  context: ResourceDiagnosticsContext,
  expanded: ReadonlySet<string>,
): FlattenedRow[] {
  const rows: FlattenedRow[] = [];
  const rootRows = roots.map((item) => {
    const details = deriveRowDetails(item, context, null);
    return {
      id: `${item.groupId}:${getProcessPathSegment(item)}`,
      groupId: item.groupId,
      groupLabel: GROUP_LABELS[item.groupId],
      process: item,
      secondaryText: details.secondaryText,
      navigationTarget: details.navigationTarget,
      attributionLabel: details.attributionLabel,
      depth: 0,
      hasChildren: (item.children ?? []).some(shouldRenderProcess),
      path: getProcessPathSegment(item),
    };
  });

  const appendProcess = (row: FlattenedRow & { path: string }): void => {
    rows.push(row);
    if (!expanded.has(row.id)) return;
    const children = [...(row.process.children ?? [])]
      .filter(shouldRenderProcess)
      .map((child) => {
        const childSegment = getProcessPathSegment(child);
        const path = `${row.path}:child:${childSegment}`;
        const details = deriveRowDetails(child, context, {
          attributionLabel: row.attributionLabel,
          navigationTarget: row.navigationTarget,
        });
        return {
          id: `${row.groupId}:${path}`,
          groupId: row.groupId,
          groupLabel: row.groupLabel,
          process: child,
          secondaryText: details.secondaryText,
          navigationTarget: details.navigationTarget,
          attributionLabel: details.attributionLabel,
          depth: row.depth + 1,
          hasChildren: (child.children ?? []).some(shouldRenderProcess),
          path,
        };
      })
      .sort((a, b) => compareRows(a, b, sort));
    children.forEach(appendProcess);
  };

  rootRows.sort((a, b) => compareRows(a, b, sort)).forEach(appendProcess);
  return rows;
}

function resolveWorktreeAttribution(
  context: ResourceDiagnosticsContext,
  target: WorktreeNavigationTarget,
): WorktreeAttribution {
  const project = context.projects.find(
    (candidate) => candidate.id === target.projectId,
  );
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find(
          (candidate) => candidate.id === target.worktreeId,
        )
      : undefined;
  const workspaceLabel = project?.name ?? target.projectId;
  const worktreeLabel =
    worktree?.branchName ?? worktree?.id ?? target.worktreeId;
  return {
    ...target,
    label: `${workspaceLabel} / ${worktreeLabel}`,
    navigable: canNavigateToWorktreeFromSidebarItems(
      context.projects,
      target.projectId,
      target.worktreeId,
      context.hasHydratedProjects,
    ),
  };
}

function pidLabel(process: ResourceProcessSnapshot): string | null {
  return typeof process.pid === 'number' && process.pid > 0
    ? `PID ${process.pid}`
    : null;
}

function deriveInheritedRowDetails(
  process: ResourceProcessSnapshot,
  inherited: InheritedRowContext | null,
): ResourceRowDetails | null {
  if (!inherited?.attributionLabel) {
    return null;
  }
  const parts = [inherited.attributionLabel, pidLabel(process)].filter(
    (part): part is string => Boolean(part),
  );
  return {
    secondaryText: parts.join(' / '),
    attributionLabel: inherited.attributionLabel,
    navigationTarget: inherited.navigationTarget,
  };
}

function deriveRowDetails(
  process: ResourceProcessSnapshot,
  context: ResourceDiagnosticsContext,
  inherited: InheritedRowContext | null,
): ResourceRowDetails {
  const meta = process.metadata;
  if (!meta) {
    return (
      deriveInheritedRowDetails(process, inherited) ?? {
        secondaryText: null,
        attributionLabel: inherited?.attributionLabel ?? null,
        navigationTarget: inherited?.navigationTarget ?? null,
      }
    );
  }
  if (meta.type === 'codex-pool') {
    const { codexPool } = meta;
    const pidLabel =
      typeof process.pid === 'number' && process.pid > 0
        ? `PID ${process.pid}`
        : 'not running';
    if (codexPool.pooled === false) {
      return {
        secondaryText: `Dedicated pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    const label = codexPool.poolKeyLabel ?? '';
    if (label === 'Default pool') {
      return {
        secondaryText: `Default pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    if (label === 'Dedicated pool') {
      return {
        secondaryText: `Dedicated pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    const envMatch = /^Env pool ([0-9a-fA-F]{8})$/.exec(label);
    const hash8 = envMatch?.[1] ?? label;
    return {
      secondaryText: `Env pool ${hash8} / ${codexPool.clientCount} clients / ${pidLabel}`,
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  if (meta.type === 'pipeline') {
    const pipelineMeta = meta.pipeline;
    const shortExecutionId = pipelineMeta.executionId.slice(0, 8);
    if (pipelineMeta.jobId && pipelineMeta.stepId) {
      const pidLabel =
        typeof process.pid === 'number' && process.pid > 0
          ? `PID ${process.pid}`
          : 'not running';
      return {
        secondaryText: `${pipelineMeta.jobId} / ${pipelineMeta.stepId} / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    return {
      secondaryText: `Execution ${shortExecutionId}`,
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  if (meta.type === 'browser') {
    const { browser } = meta;
    const attribution = resolveWorktreeAttribution(context, {
      projectId: browser.projectId,
      worktreeId: browser.worktreeId,
    });
    const parts = [
      attribution.label,
      pidLabel(process),
      browser.visible ? 'visible' : 'hidden',
      browser.status,
      browser.displayUrl,
    ].filter((part): part is string => Boolean(part));
    return {
      secondaryText: parts.join(' / '),
      attributionLabel: attribution.label,
      navigationTarget: attribution.navigable
        ? { projectId: browser.projectId, worktreeId: browser.worktreeId }
        : null,
    };
  }
  if (meta.type === 'script') {
    const { script } = meta;
    const attribution = resolveWorktreeAttribution(context, {
      projectId: script.projectId,
      worktreeId: script.worktreeId,
    });
    const parts = [
      attribution.label,
      pidLabel(process),
      script.repoName,
      script.invocation,
    ].filter((part): part is string => Boolean(part));
    return {
      secondaryText: parts.join(' / '),
      attributionLabel: attribution.label,
      navigationTarget: attribution.navigable
        ? { projectId: script.projectId, worktreeId: script.worktreeId }
        : null,
    };
  }
  if (meta.type === 'generic') {
    const inheritedDetails = deriveInheritedRowDetails(process, inherited);
    if (inheritedDetails) {
      return inheritedDetails;
    }
    return {
      secondaryText: pidLabel(process),
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  return (
    deriveInheritedRowDetails(process, inherited) ?? {
      secondaryText: null,
      attributionLabel: null,
      navigationTarget: null,
    }
  );
}

export function ResourceDiagnosticsPopover({
  snapshot,
  error,
  onClose,
  loading = false,
  panelRef,
  style,
  positioned = true,
}: ResourceDiagnosticsPopoverProps): JSX.Element {
  const openSettings = useNavigationStore((s) => s.openSettings);
  const navigate = useNavigationStore((s) => s.navigate);
  const selectWorktree = useChatStore((s) => s.selectWorktree);
  const projects = useProjectsStore((s) => s.projects);
  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  const [sort, setSortLocal] = useState<ResourceDiagnosticsSortState>(
    getResourceDiagnosticsSortState,
  );
  // Trees start collapsed; row ids are stable across samples.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const headerRef = useRef<HTMLTableSectionElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  function toggleExpanded(rowId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }

  function setSort(next: ResourceDiagnosticsSortState): void {
    setResourceDiagnosticsSortState(next);
    setSortLocal(next);
  }

  function handleHeaderClick(column: ResourceDiagnosticsSortColumn): void {
    if (sort.column === column) {
      setSort({
        column,
        direction: sort.direction === 'asc' ? 'desc' : 'asc',
      });
      return;
    }
    setSort({ column, direction: column === 'name' ? 'asc' : 'desc' });
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return (): void => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  function handleOpenPerformanceSettings(): void {
    openSettings('performance');
    onClose();
  }

  function handleNavigateToWorktree(target: WorktreeNavigationTarget): void {
    navigate('main');
    selectWorktree(target.projectId, target.worktreeId);
    onClose();
  }

  const diagnosticsContext = useMemo(
    (): ResourceDiagnosticsContext => ({
      projects,
      hasHydratedProjects,
    }),
    [projects, hasHydratedProjects],
  );
  const roots = useMemo(
    () => (snapshot ? getRootProcesses(snapshot) : []),
    [snapshot],
  );
  const rows = useMemo(
    () => flattenRows(roots, sort, diagnosticsContext, expanded),
    [roots, sort, diagnosticsContext, expanded],
  );
  const appManagedTotals = useMemo(() => getAppManagedTotals(roots), [roots]);
  const hasRows = rows.length > 0;

  useLayoutEffect(() => {
    setHeaderHeight(headerRef.current?.offsetHeight ?? 0);
  }, [hasRows]);

  return (
    <DropdownMenuSurface
      ref={panelRef}
      role="dialog"
      aria-label="Resources"
      padding="readout"
      data-testid="resource-diagnostics-popover"
      data-positioned={positioned ? 'true' : 'false'}
      style={style}
      className="canopy-floating-menu w-80"
    >
      <div className="flex flex-col gap-2">
        <div className="flex shrink-0 items-center gap-3">
          <h3 className="min-w-0 flex-1 truncate text-s font-normal fg-primary">
            Resources
          </h3>
          {snapshot && (
            <span
              className="flex gap-2 text-xs tabular-nums fg-tertiary"
              data-testid="resource-diagnostics-popover-totals"
            >
              <span>{formatCpuPercent(snapshot.cpuPercent)}% CPU</span>
              <span>{formatMemoryBytes(snapshot.memoryRssBytes)}</span>
            </span>
          )}
          <RailIconButton
            icon={SettingsIcon}
            hoverSurface
            aria-label="Open performance settings"
            tooltipLabel="Performance settings"
            data-testid="resource-diagnostics-popover-settings"
            onClick={handleOpenPerformanceSettings}
            // The glyph, not the button, meets the 12px content inset.
            className="-my-1 -mr-1"
          />
        </div>

        <OverlayScrollArea
          className="min-h-0"
          viewportClassName="max-h-80 overflow-x-hidden"
          viewportProps={{
            'data-testid': 'resource-diagnostics-popover-scroll',
          }}
          edgeFadeSize={16}
          // Rows fade as they pass under the sticky header, not the header.
          edgeFadeTopInset={headerHeight}
        >
          {loading && (
            <p className="text-xs fg-tertiary">Measuring resources…</p>
          )}

          {!loading && !snapshot && error && (
            <p className="text-xs fg-destructive">
              Resource metrics unavailable
            </p>
          )}

          {!loading && !snapshot && !error && (
            <p className="text-xs fg-tertiary">No resource samples yet.</p>
          )}

          {snapshot && (
            <>
              {error && (
                <p
                  className="mb-2 text-xs fg-destructive"
                  data-testid="resource-diagnostics-popover-error"
                >
                  Resource metrics unavailable
                </p>
              )}

              {rows.length === 0 ? (
                <p className="text-xs fg-tertiary">No resource samples yet.</p>
              ) : (
                <table className="w-full table-fixed text-xs">
                  <colgroup>
                    <col className="w-5" />
                    <col />
                    <col className="w-12" />
                    <col className="w-20" />
                  </colgroup>
                  <thead
                    ref={headerRef}
                    className="sticky top-0 z-1 bg-quaternary"
                  >
                    <tr>
                      <th aria-hidden="true" className="pb-1" />
                      <SortHeader
                        label="Name"
                        column="name"
                        sort={sort}
                        onClick={handleHeaderClick}
                        align="start"
                      />
                      <SortHeader
                        label="CPU"
                        column="cpu"
                        sort={sort}
                        onClick={handleHeaderClick}
                        align="end"
                      />
                      <SortHeader
                        label="Memory"
                        column="memory"
                        sort={sort}
                        onClick={handleHeaderClick}
                        align="end"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <ResourceRow
                        key={row.id}
                        row={row}
                        expanded={expanded.has(row.id)}
                        onToggle={toggleExpanded}
                        onNavigate={handleNavigateToWorktree}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </OverlayScrollArea>

        {snapshot && (
          <div
            className="flex shrink-0 items-center gap-3 border-t border-subtle pt-2 text-xs"
            data-testid="resource-diagnostics-popover-app-totals"
          >
            <span className="flex w-5 shrink-0 items-center" aria-hidden="true">
              <AppSourceIcon />
            </span>
            <span className="min-w-0 flex-1 truncate fg-secondary">
              App processes
            </span>
            <span className="flex gap-2 tabular-nums fg-secondary">
              <span>{formatCpuPercent(appManagedTotals.cpuPercent)}% CPU</span>
              <span>{formatMemoryBytes(appManagedTotals.memoryRssBytes)}</span>
            </span>
          </div>
        )}
      </div>
    </DropdownMenuSurface>
  );
}

interface SortHeaderProps {
  label: string;
  column: ResourceDiagnosticsSortColumn;
  sort: ResourceDiagnosticsSortState;
  onClick: (column: ResourceDiagnosticsSortColumn) => void;
  /** Numbers right-align so their digits line up. */
  align: 'start' | 'end';
}

function SortHeader({
  label,
  column,
  sort,
  onClick,
  align,
}: SortHeaderProps): JSX.Element {
  const isActive = sort.column === column;
  const ariaSort: 'ascending' | 'descending' | 'none' = isActive
    ? sort.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  // The slot is kept on every header so a label never moves when its
  // column becomes the sort.
  const indicator = (
    <ChevronDownIcon
      aria-hidden="true"
      className={`transition-transform motion-reduce:transition-none ${
        isActive ? '' : 'invisible'
      } ${isActive && sort.direction === 'asc' ? 'rotate-180' : ''}`}
    />
  );
  return (
    <th
      className={`pb-1 font-normal ${
        align === 'end' ? 'pl-3 text-right' : 'text-left'
      }`}
      aria-sort={ariaSort}
      data-testid={`resource-diagnostics-popover-sort-${column}`}
    >
      <button
        type="button"
        onClick={(): void => onClick(column)}
        className={`focus-ring inline-flex items-center gap-0.5 rounded-sm transition-colors hover:fg-primary ${
          isActive ? 'fg-secondary' : 'fg-tertiary'
        }`}
        data-active={isActive ? 'true' : 'false'}
      >
        {/* A number column's label ends flush with its digits, so its
            indicator leads; the name column's trails. */}
        {align === 'end' ? indicator : null}
        <span>{label}</span>
        {align === 'start' ? indicator : null}
      </button>
    </th>
  );
}

function ResourceRow({
  row,
  expanded,
  onToggle,
  onNavigate,
}: {
  row: FlattenedRow;
  expanded: boolean;
  onToggle: (rowId: string) => void;
  onNavigate: (target: WorktreeNavigationTarget) => void;
}): JSX.Element {
  const { process, groupLabel, secondaryText, depth, navigationTarget } = row;
  const displayLabel = getProcessDisplayLabel(process);
  const SourceIcon = SOURCE_ICONS[process.groupId];
  // One line per process: the group, PID, and owner are details, shown on
  // hover and read out with the name rather than taking a second line.
  const details = `${groupLabel}${secondaryText ? ` · ${secondaryText}` : ''}`;
  const clickable = navigationTarget !== null;
  const handleClick = (): void => {
    if (navigationTarget) {
      onNavigate(navigationTarget);
    }
  };
  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLTableRowElement>,
  ): void => {
    if (!navigationTarget || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onNavigate(navigationTarget);
    }
  };
  const sourceIcon = (
    <span className="flex h-3 w-3 items-center justify-center fg-tertiary">
      <SourceIcon width={SOURCE_ICON_SIZE} height={SOURCE_ICON_SIZE} />
    </span>
  );
  return (
    <tr
      data-testid={`resource-row-${process.id}`}
      className={`group ${
        clickable
          ? 'cursor-pointer outline-none transition-colors hover:bg-subtle focus-visible:bg-subtle'
          : ''
      }`}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? 'button' : undefined}
      title={`${displayLabel}\n${details}${clickable ? '\nOpen worktree' : ''}`}
    >
      <td className="py-1 align-middle">
        {row.hasChildren ? (
          // The source icon turns into the disclosure toggle on hover.
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${displayLabel}`}
            data-testid={`resource-row-toggle-${process.id}`}
            className="focus-ring flex rounded-sm fg-tertiary hover:fg-primary"
            onClick={(event): void => {
              event.stopPropagation();
              onToggle(row.id);
            }}
          >
            <span className="group-hover:hidden group-focus-visible:hidden group-has-[:focus-visible]:hidden">
              {sourceIcon}
            </span>
            <ChevronRightIcon
              aria-hidden="true"
              width={SOURCE_ICON_SIZE}
              height={SOURCE_ICON_SIZE}
              className={`hidden group-hover:block group-focus-visible:block group-has-[:focus-visible]:block transition-transform motion-reduce:transition-none ${
                expanded ? 'rotate-90' : ''
              }`}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="flex">
            {sourceIcon}
          </span>
        )}
      </td>
      <td className="py-1">
        <div className="truncate" style={{ paddingLeft: depth * 12 }}>
          <span className="fg-primary">{displayLabel}</span>
          <span className="sr-only">, {details}</span>
        </div>
      </td>
      <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums fg-secondary">
        {formatCpuPercent(process.cpuPercent)}%
      </td>
      <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums fg-secondary">
        {formatMemoryBytes(process.memoryRssBytes)}
      </td>
    </tr>
  );
}
