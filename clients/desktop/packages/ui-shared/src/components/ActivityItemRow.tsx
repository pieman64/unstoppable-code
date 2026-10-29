import {
  Children,
  Fragment,
  isValidElement,
  type JSX,
  type ReactNode,
} from 'react';
import {
  COMPACT_ACTIVITY_ITEM_CLASS_NAME,
  useActivityItemDensity,
} from './activity-item-density';

function actionTrackCount(content: ReactNode): number {
  return Children.toArray(content).reduce<number>((count, child) => {
    return (
      count +
      (isValidElement<{ children?: ReactNode }>(child) &&
      child.type === Fragment
        ? actionTrackCount(child.props.children)
        : 1)
    );
  }, 0);
}

/** Shared configured-item row used by Scripts and Plugins activity sections. */
export function ActivityItemRow({
  label,
  labelTitle,
  icon,
  children,
  secondaryContent,
  dataTestId,
}: {
  label: ReactNode;
  labelTitle?: string;
  icon?: ReactNode;
  children?: ReactNode;
  /** Optional metadata below the label, extending through the action space. */
  secondaryContent?: ReactNode;
  dataTestId?: string;
}): JSX.Element {
  const compact = useActivityItemDensity() === 'compact';
  const hasSecondary = secondaryContent != null && secondaryContent !== false;
  const hasIcon = Boolean(icon);
  const actionTracks = hasSecondary ? actionTrackCount(children) : 0;
  return (
    <div
      className={
        compact
          ? `group ${hasSecondary ? 'grid gap-y-0.5 [&>*]:row-start-1' : 'flex'} ${COMPACT_ACTIVITY_ITEM_CLASS_NAME}`
          : `group ${hasSecondary ? 'grid' : 'flex'} w-full items-center ${hasSecondary ? 'gap-x-2 gap-y-1 [&>*]:row-start-1' : 'gap-2'} rounded-lg border bg-fg-primary/[0.03] px-2.5 py-2 text-left text-xs`
      }
      style={
        hasSecondary
          ? {
              gridTemplateColumns: `${hasIcon ? 'auto ' : ''}minmax(0, 1fr)${' auto'.repeat(actionTracks)}`,
            }
          : undefined
      }
      data-testid={dataTestId}
      data-activity-item-row="true"
    >
      {icon && (
        <span
          className="flex shrink-0 items-center justify-center fg-secondary"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 ${compact ? 'truncate fg-primary' : 'font-medium fg-primary/80'}`}
        title={labelTitle}
      >
        {label}
      </span>
      {children}
      {hasSecondary ? (
        <div
          className="min-w-0"
          style={{ gridRow: 2, gridColumn: `${hasIcon ? 2 : 1} / -1` }}
        >
          {secondaryContent}
        </div>
      ) : null}
    </div>
  );
}
