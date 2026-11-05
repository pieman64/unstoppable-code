import type { JSX, SVGProps } from 'react';

/*
 * Issue status glyphs modelled on Linear's: one ring drawn the same way for
 * every status, filled by a pie for work in progress and solid for a closed
 * status. They draw in `currentColor`, so the caller picks the status ink,
 * and the check and cross are cut out of the disc, so they show whatever
 * surface sits behind them in either theme.
 */

type LinearStatusIconProps = SVGProps<SVGSVGElement> & {
  /** Marks the glyph as sized by its caller, as the app icons do. */
  readonly exactSize?: boolean;
  /** The app icon size step; these glyphs draw at `sm` (14px). */
  readonly size?: 'sm';
};

const RING = { cx: 8, cy: 8, r: 6.25, strokeWidth: 1.5 } as const;

function StatusSvg({
  exactSize,
  size,
  children,
  ...props
}: LinearStatusIconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-icon-size={exactSize ? 'exact' : size}
      {...props}
    >
      {children}
    </svg>
  );
}

/** A pie from 12 o'clock clockwise over `fraction` of the inner disc. */
function piePath(fraction: number): string {
  const radius = 3.5;
  const angle = fraction * 2 * Math.PI;
  const x = 8 + radius * Math.sin(angle);
  const y = 8 - radius * Math.cos(angle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M8 8V${8 - radius}A${radius} ${radius} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

export function LinearBacklogIcon(props: LinearStatusIconProps): JSX.Element {
  return (
    <StatusSvg {...props}>
      <circle {...RING} stroke="currentColor" strokeDasharray="2.2 1.73" />
    </StatusSvg>
  );
}

export function LinearTodoIcon(props: LinearStatusIconProps): JSX.Element {
  return (
    <StatusSvg {...props}>
      <circle {...RING} stroke="currentColor" />
    </StatusSvg>
  );
}

export function LinearInProgressIcon(
  props: LinearStatusIconProps,
): JSX.Element {
  return (
    <StatusSvg {...props}>
      <circle {...RING} stroke="currentColor" />
      <path d={piePath(0.5)} fill="currentColor" />
    </StatusSvg>
  );
}

export function LinearInReviewIcon(props: LinearStatusIconProps): JSX.Element {
  return (
    <StatusSvg {...props}>
      <circle {...RING} stroke="currentColor" />
      <path d={piePath(0.75)} fill="currentColor" />
    </StatusSvg>
  );
}

/** The disc a closed status fills: the ring's outer size, so a closed status is
 * the same size as an open one. */
const DISC = 'M1 8a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z';

/**
 * A solid disc with `mark` (an outlined shape) cut out of it by the even-odd
 * rule, so the mark shows whatever surface sits behind it in either theme.
 */
function CutDisc({
  mark,
  ...props
}: LinearStatusIconProps & { readonly mark: string }): JSX.Element {
  return (
    <StatusSvg {...props}>
      <path d={`${DISC}${mark}`} fill="currentColor" fillRule="evenodd" />
    </StatusSvg>
  );
}

export function LinearDoneIcon(props: LinearStatusIconProps): JSX.Element {
  return (
    <CutDisc
      {...props}
      mark="M4.4 8.46 7.12 11.19 11.61 6.27 10.5 5.26 7.08 9.01 5.46 7.4Z"
    />
  );
}

export function LinearCanceledIcon(props: LinearStatusIconProps): JSX.Element {
  return (
    <CutDisc
      {...props}
      mark="M6 11.06 8 9.06 10 11.06 11.06 10 9.06 8 11.06 6 10 4.94 8 6.94 6 4.94 4.94 6 6.94 8 4.94 10Z"
    />
  );
}
