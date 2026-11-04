import { Fragment, type JSX, type ReactNode, useMemo } from 'react';
import type {
  EnvironmentConfigView,
  EnvironmentRuntime,
} from '@canopy/desktop-shared/types';
import { getEnvironmentUsage } from '@canopy/desktop-shared/lib/user-environment';
import { BranchIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  AgentIcon,
  CommandIcon,
  FolderIcon,
  PipelineIcon,
} from '@canopy/ui-shared/icons';
import { BrandLogo } from '@/components/BrandLogo';
import { brandText } from '@/lib/brand';
import { SettingsButtonRow } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
} from '@/components/settings/SettingsLayout';

export interface EnvironmentUsageWorkspace {
  id: string;
  name: string;
  workspaceKind: 'code' | 'cowork';
}

interface EnvironmentUsageListProps {
  /** Environment id whose usage we want to render. */
  environmentId: string | null;
  /** Latest config used to compute global + workspace assignments. */
  config: EnvironmentConfigView;
  /** Workspaces the renderer currently knows about, used for display names. */
  workspaces: ReadonlyArray<EnvironmentUsageWorkspace>;
  /**
   * Invoked when the user clicks a usage row that points at another
   * environment (currently the `parent` rows). Settings → Environments
   * passes a handler that opens that environment's detail.
   */
  onSelectEnvironment?: (environmentId: string) => void;
  /**
   * Invoked when the user clicks a `workspace-runtime` usage row. Expected
   * to navigate to the workspace and open the workspace settings modal on
   * the Environment tab.
   */
  onOpenWorkspaceSettings?: (workspaceId: string) => void;
  /**
   * Invoked when the user clicks a `global-runtime` usage row. Expected to
   * open the global runtime defaults modal in Settings → Environments.
   */
  onOpenGlobalDefaults?: () => void;
}

const RUNTIME_LABEL: Record<EnvironmentRuntime, string> = {
  canopy: brandText.shortName,
  agent: 'Agent',
  pipeline: 'Workflow',
};

function RuntimeKindIcon({
  runtime,
}: {
  runtime: EnvironmentRuntime;
}): JSX.Element {
  if (runtime === 'canopy') {
    return (
      <BrandLogo
        width={14}
        height={14}
        className="shrink-0 fg-secondary"
        aria-hidden={true}
      />
    );
  }
  if (runtime === 'agent') {
    return <AgentIcon className="shrink-0 fg-secondary" />;
  }
  return <PipelineIcon className="shrink-0 fg-secondary" />;
}

interface RuntimeRow {
  kind: 'runtime';
  id: string;
  scope: string;
  scopeKind: 'global' | 'workspace';
  runtime: EnvironmentRuntime;
  workspaceId?: string;
  workspaceKind?: 'code' | 'cowork';
}

interface ParentRow {
  kind: 'parent';
  id: string;
  childEnvironmentId: string;
  childName: string;
}

type UsageRow = RuntimeRow | ParentRow;

/**
 * Renders a flat list of usage rows for the selected environment. Used in
 * the Settings → Environments detail. Empty state copy matches the plan
 * exactly so test selectors are stable.
 */
export function EnvironmentUsageList({
  environmentId,
  config,
  workspaces,
  onSelectEnvironment,
  onOpenWorkspaceSettings,
  onOpenGlobalDefaults,
}: EnvironmentUsageListProps): JSX.Element {
  const { hasRuntimeAssignment, rows } = useMemo(() => {
    if (!environmentId)
      return {
        hasRuntimeAssignment: false,
        rows: [] as UsageRow[],
      };
    const usage = getEnvironmentUsage(
      config,
      workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
      })),
    );
    const entries = usage.filter(
      (entry) => entry.environmentId === environmentId,
    );
    const workspaceKindById = new Map(
      workspaces.map((workspace) => [workspace.id, workspace.workspaceKind]),
    );
    const hasRuntimeAssignment = entries.some(
      (entry) =>
        entry.kind === 'global-runtime' || entry.kind === 'workspace-runtime',
    );
    const rows: UsageRow[] = [];
    entries.forEach((entry, index) => {
      if (entry.kind === 'global-runtime' && entry.runtime) {
        rows.push({
          kind: 'runtime',
          id: `global-${entry.runtime}-${index}`,
          scope: 'Global',
          scopeKind: 'global',
          runtime: entry.runtime,
        });
        return;
      }
      if (entry.kind === 'workspace-runtime' && entry.runtime) {
        const name = entry.workspaceName ?? entry.workspaceId ?? 'Project';
        rows.push({
          kind: 'runtime',
          id: `${entry.workspaceId}-${entry.runtime}-${index}`,
          scope: name,
          scopeKind: 'workspace',
          runtime: entry.runtime,
          workspaceId: entry.workspaceId,
          workspaceKind:
            workspaceKindById.get(entry.workspaceId ?? '') ?? 'code',
        });
        return;
      }
      if (entry.kind === 'parent' && entry.childEnvironmentId) {
        const child = config.environments.find(
          (environment) => environment.id === entry.childEnvironmentId,
        );
        rows.push({
          kind: 'parent',
          id: `parent-${entry.childEnvironmentId}-${index}`,
          childEnvironmentId: entry.childEnvironmentId,
          childName: child?.name ?? entry.childEnvironmentId,
        });
      }
    });
    return { hasRuntimeAssignment, rows };
  }, [config, environmentId, workspaces]);

  if (rows.length === 0) {
    return (
      <SettingsGroup>
        <p
          className="text-s fg-secondary"
          data-testid="environment-usage-empty"
        >
          This environment is not assigned to any runtime.
        </p>
      </SettingsGroup>
    );
  }

  // One row per usage in the section's group; a row that leads somewhere
  // (a project's settings, the global defaults, a child environment) opens it.
  return (
    <SettingsGroup dataTestId="environment-usage-list">
      {!hasRuntimeAssignment && (
        <p
          className="text-s fg-secondary"
          data-testid="environment-usage-empty"
        >
          This environment is not assigned to any runtime.
        </p>
      )}
      {rows.map((row) => (
        <Fragment key={row.id}>
          {renderRow(row, {
            onSelectEnvironment,
            onOpenWorkspaceSettings,
            onOpenGlobalDefaults,
          })}
        </Fragment>
      ))}
    </SettingsGroup>
  );
}

/** A usage's icons and text, on one line that truncates. */
function UsageLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className="flex min-w-0 items-center gap-2">{children}</span>;
}

interface RowCallbacks {
  onSelectEnvironment?: (environmentId: string) => void;
  onOpenWorkspaceSettings?: (workspaceId: string) => void;
  onOpenGlobalDefaults?: () => void;
}

function renderRow(row: UsageRow, callbacks: RowCallbacks): ReactNode {
  if (row.kind === 'runtime') {
    const runtimeLabel = `${RUNTIME_LABEL[row.runtime]} Runtime`;
    const fullLabel = `${row.scope} · ${runtimeLabel}`;
    const inner = (
      <>
        {row.scopeKind === 'workspace' && (
          <>
            {row.workspaceKind === 'cowork' ? (
              <FolderIcon
                className="shrink-0 fg-secondary"
                data-testid="environment-usage-workspace-icon-cowork"
              />
            ) : (
              <BranchIcon
                size="md"
                className="shrink-0 fg-secondary"
                data-testid="environment-usage-workspace-icon-code"
              />
            )}
          </>
        )}
        <span className="truncate" title={row.scope}>
          {row.scope}
        </span>
        <span className="fg-secondary">·</span>
        <RuntimeKindIcon runtime={row.runtime} />
        <span className="truncate" title={runtimeLabel}>
          {runtimeLabel}
        </span>
      </>
    );
    const handler =
      row.scopeKind === 'global'
        ? callbacks.onOpenGlobalDefaults
        : row.workspaceId !== undefined && callbacks.onOpenWorkspaceSettings
          ? (): void =>
              callbacks.onOpenWorkspaceSettings?.(row.workspaceId ?? '')
          : undefined;
    if (handler) {
      return (
        <SettingsButtonRow
          trailing="open"
          tooltip={fullLabel}
          label={<UsageLabel>{inner}</UsageLabel>}
          onClick={handler}
          data-testid={
            row.scopeKind === 'global'
              ? `environment-usage-global-${row.runtime}`
              : `environment-usage-workspace-${row.workspaceId ?? ''}-${row.runtime}`
          }
        />
      );
    }
    return <SettingsRow label={<UsageLabel>{inner}</UsageLabel>} />;
  }
  const fullLabel = `Parent of ${row.childName}`;
  const inner = (
    <>
      <CommandIcon className="shrink-0 fg-secondary" />
      <span className="truncate">{fullLabel}</span>
    </>
  );
  if (callbacks.onSelectEnvironment) {
    return (
      <SettingsButtonRow
        trailing="open"
        tooltip={fullLabel}
        label={<UsageLabel>{inner}</UsageLabel>}
        onClick={() => callbacks.onSelectEnvironment?.(row.childEnvironmentId)}
        data-testid={`environment-usage-parent-${row.childEnvironmentId}`}
      />
    );
  }
  return <SettingsRow label={<UsageLabel>{inner}</UsageLabel>} />;
}
