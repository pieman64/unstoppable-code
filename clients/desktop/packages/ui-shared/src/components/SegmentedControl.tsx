import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import { getWindow } from '../panels/window-registry';
import { Tooltip } from './Tooltip';

export interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly dataTestId?: string;
  /**
   * Shown in place of the label, for an icon-only segment. The label stays
   * the segment's accessible name; pair it with a `tooltip` that says it.
   */
  readonly icon?: ReactNode;
  /** Shown before the label, such as a lock on a value an organization pins. */
  readonly leading?: ReactNode;
  /** Shown after the label, such as a count. */
  readonly trailing?: ReactNode;
  /** Explains the option on hover and keyboard focus. */
  readonly tooltip?: string;
  /** Shown and focusable, so its tooltip can say why, but not selectable. */
  readonly unavailable?: boolean;
  /** With `semantics="tabs"`, the tab's id. */
  readonly id?: string;
  /** With `semantics="tabs"`, the id of the panel the tab shows. */
  readonly controls?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** The chosen option, or `null` while the current value is loading. */
  readonly value: T | null;
  readonly options: readonly SegmentedControlOption<T>[];
  readonly onChange: (next: T) => void;
  /** Accessible name for the group. */
  readonly label: string;
  /**
   * `toggle` switches a setting in place: a group of pressed buttons. `tabs`
   * switches the view below it: a tablist whose tabs name their panels.
   */
  readonly semantics?: 'toggle' | 'tabs';
  /**
   * `control`: at least the settings control column (208px), so a stack of
   * settings rows lines its pickers up edge to edge; a picker whose labels do
   * not fit grows past it. `fill`: the full width of its row. `content`: only
   * as wide as its labels, for a picker whose segments size to their labels
   * (each under a tooltip) and would otherwise leave an empty run of track.
   */
  readonly width?: 'control' | 'fill' | 'content';
  /**
   * `rounded` (default): the 8px corner of the settings control rectangle.
   * `capsule`: the 28px capsule of the compact settings buttons.
   */
  readonly shape?: SegmentedControlShape;
  readonly disabled?: boolean;
  /** The track's test id; the sliding surface takes it with `-indicator`. */
  readonly dataTestId?: string;
}

/** The track's corner: the control rectangle or the compact capsule. */
export type SegmentedControlShape = 'rounded' | 'capsule';

/**
 * The 28px height of the settings buttons, sunk into the `bg-depth` well so
 * the raised segment stands above it, with the segments inset 2px.
 */
const TRACK_CLASS_NAME =
  'relative inline-flex h-7 shrink-0 items-stretch gap-0.5 bg-depth p-0.5';

/** The 8px corner of the control rectangle, or the compact capsule. */
const TRACK_CORNER_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'rounded-md',
  capsule: 'rounded-full',
};

const TRACK_WIDTH_CLASS_NAME = {
  control: 'min-w-52',
  fill: 'w-full',
  content: '',
} as const;

/**
 * The segment's corner nests inside the track's: 8px less the 2px inset, or
 * a capsule inside the capsule track, so the corners nest at any width.
 */
const SEGMENT_CORNER_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'rounded-[calc(var(--radius-md)-2px)]',
  capsule: 'rounded-full',
};

/** The capsule segment takes the compact button's 12px sides. */
const SEGMENT_PADDING_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'px-2',
  capsule: 'px-3',
};

/** An icon-only segment: a square inside the 28px track. */
const ICON_SEGMENT_PADDING_CLASS_NAME = 'w-6 px-0';

function segmentClassName(
  selected: boolean,
  unavailable: boolean,
  shape: SegmentedControlShape,
  iconOnly: boolean,
): string {
  return `focus-ring relative inline-flex flex-1 basis-0 items-center justify-center gap-1 whitespace-nowrap ${iconOnly ? ICON_SEGMENT_PADDING_CLASS_NAME : SEGMENT_PADDING_CLASS_NAME[shape]} text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${SEGMENT_CORNER_CLASS_NAME[shape]} ${
    selected ? 'fg-primary' : 'fg-secondary hover:fg-primary'
  }${unavailable ? ' cursor-not-allowed opacity-60' : ''}`;
}

/** Realm-neutral, for a picker rendered into an auxiliary window. */
function isHtmlElement(node: Element): node is HTMLElement {
  return 'offsetLeft' in node && 'offsetParent' in node;
}

/**
 * The element's left edge within the track, from layout offsets rather than
 * client rects, so a popover's scale-in does not skew the measurement. A
 * tooltip wraps its segment in a positioned span, so the offsets are summed
 * up to the track.
 */
function offsetLeftWithin(element: HTMLElement, track: HTMLElement): number {
  let left = 0;
  let node: Element | null = element;
  while (node && node !== track && isHtmlElement(node)) {
    left += node.offsetLeft;
    node = node.offsetParent;
  }
  return left;
}

interface SurfacePlacement {
  readonly left: number;
  readonly width: number;
}

/**
 * Two to four short, mutually exclusive choices. The chosen segment is raised
 * on the secondary button's resting surface, which slides to the picked
 * segment rather than jumping, so the picker reads as one control moving
 * between places. Settings rows and the usage popover share it.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  semantics = 'toggle',
  width = 'control',
  shape = 'rounded',
  disabled,
  dataTestId,
}: SegmentedControlProps<T>): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<SurfacePlacement | null>(null);

  // Measured rather than computed from the option count: segments under a
  // tooltip size to their labels, so they are not equal. The surface is
  // first drawn already in place, so it never slides in on mount.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const measure = (): void => {
      const selected = track.querySelector('[data-segment-selected="true"]');
      const next =
        selected && isHtmlElement(selected)
          ? {
              left: offsetLeftWithin(selected, track),
              width: selected.offsetWidth,
            }
          : null;
      setSurface((previous) =>
        previous &&
        next &&
        previous.left === next.left &&
        previous.width === next.width
          ? previous
          : next,
      );
    };
    measure();
    const view = getWindow(track);
    const observer =
      typeof view.ResizeObserver === 'function'
        ? new view.ResizeObserver(measure)
        : null;
    observer?.observe(track);
    return (): void => observer?.disconnect();
  }, [value, options]);

  const tabs = semantics === 'tabs';
  return (
    <div
      ref={trackRef}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      data-testid={dataTestId}
      className={`${TRACK_CLASS_NAME} ${TRACK_CORNER_CLASS_NAME[shape]} ${TRACK_WIDTH_CLASS_NAME[width]}`.trim()}
    >
      {surface && (
        <span
          aria-hidden="true"
          data-testid={dataTestId ? `${dataTestId}-indicator` : undefined}
          className={`absolute inset-y-0.5 left-0 transition-[transform,width] duration-200 ease-out motion-reduce:transition-none ${SEGMENT_CORNER_CLASS_NAME[shape]} ${SECONDARY_SURFACE_SHELL_CLASS}`}
          style={{
            width: surface.width,
            transform: `translateX(${surface.left}px)`,
          }}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        const unavailable = option.unavailable === true;
        const iconOnly = option.icon !== undefined;
        const segment = (
          <button
            key={option.value}
            type="button"
            {...(tabs
              ? {
                  role: 'tab',
                  'aria-selected': selected,
                  id: option.id,
                  'aria-controls': option.controls,
                }
              : { 'aria-pressed': selected })}
            // An unavailable option stays focusable so its tooltip can be
            // reached; only `disabled` takes a segment out of the tab order.
            aria-label={iconOnly ? option.label : undefined}
            aria-disabled={unavailable || undefined}
            disabled={disabled}
            data-segment-selected={selected}
            data-testid={option.dataTestId}
            onClick={(): void => {
              if (!unavailable) onChange(option.value);
            }}
            className={segmentClassName(selected, unavailable, shape, iconOnly)}
          >
            {iconOnly ? (
              option.icon
            ) : (
              <>
                {option.leading}
                {option.label}
                {option.trailing}
              </>
            )}
          </button>
        );
        return option.tooltip ? (
          <Tooltip key={option.value} label={option.tooltip}>
            {segment}
          </Tooltip>
        ) : (
          segment
        );
      })}
    </div>
  );
}
