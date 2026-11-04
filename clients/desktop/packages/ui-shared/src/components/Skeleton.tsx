import { useSyncExternalStore, type JSX, type ReactNode } from 'react';
import { Skeleton as MeasuredSkeleton } from 'skullet/react';
import { REDUCED_MOTION_QUERY } from './SkeletonBlock';

/**
 * Spread onto an element inside a `Skeleton` to draw it as itself while the
 * rest loads: a heading, a column head, a label that is already known. Only
 * the values around it turn into bars.
 */
export const SKELETON_KEEP = { 'skullet-own': '' } as const;

export interface SkeletonProps {
  /** True while the content is on its way. */
  readonly loading: boolean;
  /**
   * The content's own layout. While loading, render it with sample data of
   * the real shape: skullet lays it out unseen and draws a capsule over each
   * line of text and a block over each image, field and control, so the
   * content replaces the skeleton in place.
   */
  readonly children: ReactNode;
  /** What the status region announces while loading. */
  readonly label?: string;
  /** Placement only: margin, width, and flex participation. */
  readonly className?: string;
  /** Marks the status region while loading. */
  readonly testId?: string;
}

const subscribeNever = (): (() => void) => () => {};

/**
 * False while the server renders and the client hydrates. skullet measures
 * in the browser, and its server-rendered form brings an inline script the
 * web policy's script nonce would refuse.
 */
function useMeasurable(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const query =
    typeof window === 'undefined'
      ? null
      : (window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
};

/**
 * Whether reduced motion is on, live. skullet reads it only when it draws, so
 * the measured layer is drawn again whenever it changes.
 */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true,
    () => false,
  );
}

/**
 * A skeleton in the content's final layout, measured by skullet from the
 * content itself. Wrap it in `DelayedLoadingPlaceholder` so fast loads never
 * flash it. Once loaded, the content renders directly with no skullet
 * wrapper, so nothing observes it and no shape is written to storage.
 */
export function Skeleton({
  loading,
  children,
  label = 'Loading',
  className = '',
  testId,
}: SkeletonProps): JSX.Element {
  const measurable = useMeasurable();
  const reducedMotion = useReducedMotion();
  if (!loading) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div role="status" data-testid={testId} className={className}>
      <span className="sr-only">{label}</span>
      {measurable ? (
        <MeasuredSkeleton key={reducedMotion ? 'still' : 'pulsing'} loading>
          {children}
        </MeasuredSkeleton>
      ) : (
        <div aria-hidden="true" inert className="invisible">
          {children}
        </div>
      )}
    </div>
  );
}
