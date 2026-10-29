import { type JSX, useMemo } from 'react';
import type {
  EnvironmentDefinition,
  EnvironmentRuntime,
} from '@canopy/desktop-shared/types';
import type { resolveEnvironmentVariables } from '@canopy/desktop-shared/lib/user-environment';
import { AgentIcon, CommandIcon, PipelineIcon } from '@canopy/ui-shared/icons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { BrandLogo } from '@/components/BrandLogo';
import { SettingsSelect } from '@/components/settings/SettingsLayout';
import { EnvironmentUsageRichTooltip } from './EnvironmentUsageRichTooltip';
import {
  ENVIRONMENT_RUNTIMES,
  ENVIRONMENT_RUNTIME_INDICATOR_TITLE,
  sortEnvironments,
  type UsageIndicators,
} from './environment-list-helpers';

interface UsageKindIndicatorsProps {
  environmentId: string;
  indicators: UsageIndicators;
}

/**
 * Per-kind usage icons on an environment list row. Each icon is a hover
 * tooltip naming its usages; none of them is a control, so the row stays
 * the single interactive element.
 */
export function UsageKindIndicators({
  environmentId,
  indicators,
}: UsageKindIndicatorsProps): JSX.Element | null {
  const runtimeIcons: Record<EnvironmentRuntime, JSX.Element> = {
    canopy: (
      <BrandLogo
        width={14}
        height={14}
        className="fg-secondary"
        aria-hidden={true}
      />
    ),
    agent: <AgentIcon className="fg-secondary" />,
    pipeline: <PipelineIcon className="fg-secondary" />,
  };
  const visible: ReadonlyArray<{
    key: string;
    title: string;
    items: string[];
    icon: JSX.Element;
  }> = [
    ...ENVIRONMENT_RUNTIMES.filter(
      (runtime) => indicators.runtime[runtime].length > 0,
    ).map((runtime) => ({
      key: runtime,
      title: ENVIRONMENT_RUNTIME_INDICATOR_TITLE[runtime],
      items: indicators.runtime[runtime],
      icon: runtimeIcons[runtime],
    })),
    ...(indicators.parent.length > 0
      ? [
          {
            key: 'environment',
            title: 'Used by environments',
            items: indicators.parent.map((name) => `Parent of ${name}`),
            icon: <CommandIcon className="fg-secondary" />,
          },
        ]
      : []),
  ];
  if (visible.length === 0) return null;
  return (
    <span
      className="flex items-center gap-1"
      data-testid={`environments-list-indicators-${environmentId}`}
    >
      {visible.map((entry) => (
        <EnvironmentUsageRichTooltip
          key={entry.key}
          title={entry.title}
          items={entry.items}
          dataTestId={`environments-list-indicator-tooltip-${environmentId}-${entry.key}`}
        >
          <span
            data-testid={`environments-list-indicator-${environmentId}-${entry.key}`}
            className="inline-flex"
          >
            {entry.icon}
          </span>
        </EnvironmentUsageRichTooltip>
      ))}
    </span>
  );
}

interface ParentSelectProps {
  id?: string;
  environments: ReadonlyArray<EnvironmentDefinition>;
  blockedIds: ReadonlySet<string>;
  currentId: string;
  value: string | null;
  onChange: (next: string | null) => void;
}

/** Picks the environment this one inherits from, excluding its descendants. */
export function ParentSelect({
  id,
  environments,
  blockedIds,
  currentId,
  value,
  onChange,
}: ParentSelectProps): JSX.Element {
  const options = useMemo(
    () =>
      sortEnvironments(
        environments.filter(
          (environment) =>
            environment.id !== currentId && !blockedIds.has(environment.id),
        ),
      ),
    [blockedIds, currentId, environments],
  );

  return (
    <SettingsSelect
      id={id}
      value={value ?? ''}
      onChange={(event) =>
        onChange(event.target.value.length === 0 ? null : event.target.value)
      }
      data-testid="environments-parent-select"
    >
      <option value="">No parent</option>
      {options.map((environment) => (
        <option key={environment.id} value={environment.id}>
          {environment.name}
        </option>
      ))}
    </SettingsSelect>
  );
}

interface ResolvedVariablesListProps {
  resolved: ReturnType<typeof resolveEnvironmentVariables> | null;
  sources: ReadonlyMap<string, string>;
}

/** The environment's variables after inheritance, with each value's source. */
export function ResolvedVariablesList({
  resolved,
  sources,
}: ResolvedVariablesListProps): JSX.Element {
  const entries = useMemo(
    () =>
      resolved
        ? Object.entries(resolved.applied).sort(([a], [b]) =>
            a.localeCompare(b),
          )
        : [],
    [resolved],
  );
  if (!resolved || entries.length === 0) {
    return (
      <p className="text-xs fg-secondary">
        No variables resolved for this environment.
      </p>
    );
  }
  return (
    // Resolved `KEY=value` pairs include secret values: blocked in replay.
    <ul
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} space-y-1`}
      data-testid="environments-resolved-list"
    >
      {entries.map(([key, value]) => {
        const source = sources.get(key);
        return (
          <li
            key={key}
            className="flex items-center justify-between gap-3 rounded border bg-card/40 px-2.5 py-1.5"
          >
            <span className="truncate font-mono text-xs fg-primary">
              <span className="font-semibold">{key}</span>
              <span className="fg-secondary">={value}</span>
            </span>
            {source && (
              <span className="shrink-0 text-3xs fg-secondary">{source}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
