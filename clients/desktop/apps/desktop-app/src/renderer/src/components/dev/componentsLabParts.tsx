import { Heading } from '@canopy/ui-shared/components';
import { useEffect, useRef, type JSX, type ReactNode } from 'react';

/**
 * Layout helpers for the components library's specimen sheets. They only
 * place the real shared components on the page and label each cell; they
 * never restyle what they hold.
 */

export function SpecimenPanel({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {title ? (
        <Heading level={3} variant="label">
          {title}
        </Heading>
      ) : null}
      <div className="flex flex-col gap-4 rounded-lg bg-secondary p-4">
        {children}
      </div>
    </div>
  );
}

/** A labelled cell: the specimen, then a quiet caption under it. */
export function SpecimenCell({
  label,
  children,
  wide = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly wide?: boolean;
}): JSX.Element {
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5${wide ? ' col-span-full' : ''}`}
    >
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
      <span className="text-2xs fg-tertiary">{label}</span>
    </div>
  );
}

/** A responsive grid of cells that wraps to one column at phone width. */
export function SpecimenGrid({
  children,
  min = 160,
}: {
  readonly children: ReactNode;
  /** Narrowest cell, in CSS px. */
  readonly min?: number;
}): JSX.Element {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Gives its first focusable descendant real browser focus once on mount, so
 * a "Focused" cell shows the focus ring without a pointer. Only one cell per
 * sheet should use it; focus moves to whichever mounted last.
 */
export function FocusOnMount({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const target = ref.current?.querySelector<HTMLElement>(
      'button, input, textarea, [tabindex]',
    );
    target?.focus({ preventScroll: true });
  }, []);
  return (
    <span ref={ref} className="contents">
      {children}
    </span>
  );
}
