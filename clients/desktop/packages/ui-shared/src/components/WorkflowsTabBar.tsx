import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import {
  BulletListIcon,
  PlayCircleIcon,
  ScheduleIcon,
} from '../icons/AppIcons';
import {
  WORKFLOWS_TAB_LABELS,
  WORKFLOWS_TABS,
  type WorkflowsTabId,
} from '../lib/workflows-tabs';

const TAB_ICONS: Readonly<Record<WorkflowsTabId, JSX.Element>> = {
  workflows: <PlayCircleIcon width={14} height={14} />,
  'workflows-schedule': <ScheduleIcon width={14} height={14} />,
  'workflows-library': <BulletListIcon width={14} height={14} />,
};

/** How the user picked a tab. */
export type WorkflowsTabChangeSource = 'pointer' | 'keyboard';

export interface WorkflowsTabBarProps {
  readonly value: WorkflowsTabId;
  readonly onChange: (
    tab: WorkflowsTabId,
    source: WorkflowsTabChangeSource,
  ) => void;
  /**
   * Focus the selected tab when the bar mounts. A host whose panels each
   * render their own bar sets it after a keyboard change, so focus follows
   * the selection into the new panel's bar.
   */
  readonly focusSelectedOnMount?: boolean;
  /**
   * A count beside a tab's label, in the current context. A tab with no
   * entry, or with zero, shows none.
   */
  readonly counts?: Readonly<Partial<Record<WorkflowsTabId, number>>>;
  /** Placement only; the tab list owns its own layout. */
  readonly className?: string;
}

/** Element id of a Workflows tab, for the panel's `aria-labelledby`. */
export function workflowsTabElementId(tab: WorkflowsTabId): string {
  return `workflows-tab-${tab}`;
}

/** Element id the host gives the panel the tabs control. */
export const WORKFLOWS_TAB_PANEL_ID = 'workflows-tab-panel';

/**
 * The Workflows page's Runs | Schedule | Library tabs (CAN-3981).
 * Only the selected tab is in the Tab order; the arrow keys, Home and End
 * move between tabs and select the one they land on.
 */
export function WorkflowsTabBar({
  value,
  onChange,
  focusSelectedOnMount = false,
  counts,
  className,
}: WorkflowsTabBarProps): JSX.Element {
  const tabRefs = useRef<Partial<Record<WorkflowsTabId, HTMLButtonElement>>>(
    {},
  );
  const initial = useRef({ value, focusSelectedOnMount });

  useEffect(() => {
    if (initial.current.focusSelectedOnMount) {
      tabRefs.current[initial.current.value]?.focus();
    }
  }, []);

  const selectAt = (index: number): void => {
    const count = WORKFLOWS_TABS.length;
    const next = WORKFLOWS_TABS[((index % count) + count) % count];
    if (next === undefined) return;
    tabRefs.current[next]?.focus();
    onChange(next, 'keyboard');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = WORKFLOWS_TABS.indexOf(value);
    switch (event.key) {
      case 'ArrowRight':
        selectAt(index + 1);
        break;
      case 'ArrowLeft':
        selectAt(index - 1);
        break;
      case 'Home':
        selectAt(0);
        break;
      case 'End':
        selectAt(WORKFLOWS_TABS.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-label="Workflows"
      data-testid="workflows-tabs"
      className={`canopy-tab-list flex shrink-0 gap-2 ${className ?? ''}`.trim()}
    >
      {WORKFLOWS_TABS.map((tab) => {
        const selected = value === tab;
        const count = counts?.[tab];
        return (
          <button
            key={tab}
            ref={(element): void => {
              if (element) tabRefs.current[tab] = element;
              else delete tabRefs.current[tab];
            }}
            type="button"
            role="tab"
            id={workflowsTabElementId(tab)}
            data-testid={`workflows-tab-${tab}`}
            aria-selected={selected}
            aria-controls={WORKFLOWS_TAB_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={(): void => onChange(tab, 'pointer')}
            onKeyDown={onKeyDown}
            className={`canopy-tab-trigger focus-ring inline-flex items-center gap-1.5 px-3 py-2 text-s transition-colors ${
              selected ? 'fg-primary' : 'fg-secondary hover:fg-primary'
            }`}
          >
            {TAB_ICONS[tab]}
            <span>{WORKFLOWS_TAB_LABELS[tab]}</span>
            {count !== undefined && count > 0 ? (
              <span
                className="text-xs tabular-nums fg-tertiary"
                data-testid={`workflows-tab-count-${tab}`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
