import type { JSX, ReactNode } from 'react';
import {
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsValue,
} from './SettingsRows';

/**
 * A list of figures as Settings rows with no box (design call 1C,
 * 2026-10-31): each figure is one 40px row, its label on the leading side
 * and its value on the trailing side, hairlines between rows. Cost and usage
 * breakdowns, account shares, a top-up's charges and a configuration's
 * values use it in panels, sheets and popovers; a detail page groups its
 * facts in the Settings box instead (docs/design/pages.md).
 */
export function ValueRows({
  dataTestId,
  children,
}: {
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <SettingsRowsGroup surface="list" dataTestId={dataTestId}>
      {children}
    </SettingsRowsGroup>
  );
}

export interface ValueRowProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** A qualifier under the label, such as a share of the total. */
  readonly note?: ReactNode;
  /** A colour swatch before the label, matching a chart series. */
  readonly swatch?: string;
  /** A share of the whole after the value, in its own aligned column. */
  readonly share?: string;
  /** Tabular figures; on by default, off for a text value. */
  readonly numeric?: boolean;
  /** A monospaced value (a key, a path, a score). */
  readonly mono?: boolean;
  /** Full value on hover. */
  readonly title?: string;
  readonly dataTestId?: string;
  /** Test id on the value. */
  readonly valueTestId?: string;
}

/** One figure in {@link ValueRows}. */
export function ValueRow({
  label,
  value,
  note,
  swatch,
  share,
  numeric = true,
  mono = false,
  title,
  dataTestId,
  valueTestId,
}: ValueRowProps): JSX.Element {
  return (
    <SettingsRowsRow
      fact
      dataTestId={dataTestId}
      label={
        swatch === undefined ? (
          label
        ) : (
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-xs"
              style={{ backgroundColor: swatch }}
            />
            {label}
          </span>
        )
      }
      description={note}
      control={
        <>
          <SettingsRowsValue
            numeric={numeric}
            mono={mono}
            dataTestId={valueTestId}
            title={title}
          >
            {value}
          </SettingsRowsValue>
          {share === undefined ? null : (
            <span className="w-12 shrink-0 text-right text-s tabular-nums fg-secondary">
              {share}
            </span>
          )}
        </>
      }
    />
  );
}
