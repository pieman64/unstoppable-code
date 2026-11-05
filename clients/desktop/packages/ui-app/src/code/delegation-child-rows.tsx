import type { JSX } from 'react';
import type { DelegationPage, PortableChildRow } from '@canopy/app-core';
import { Notice } from '@canopy/ui-shared/components';

/** A stable stored row identity, never a merged display-block identity. */
export interface DelegationChildRowEntry {
  readonly key: string;
  readonly row: PortableChildRow;
}

/** What the card around the rows already shows. */
export interface DelegationChildRowDisplay {
  /** The card's result: a text block equal to it is not repeated. */
  readonly finalText?: string;
}

/** Whether a child text block repeats the card's result, as hosts compare it. */
export function repeatsCardResult(
  text: string,
  display: DelegationChildRowDisplay | undefined,
): boolean {
  return (
    display?.finalText !== undefined && text.trim() === display.finalText.trim()
  );
}

/** Pages are in chronological order; overlapping rows appear only once. */
export function delegationChildRows(
  pages: readonly DelegationPage[],
): readonly DelegationChildRowEntry[] {
  const rows = new Map<string, PortableChildRow>();
  for (const page of pages) {
    for (const row of page.rows) rows.set(row.id, row);
  }
  return [...rows.values()].map((row) => ({ key: row.id, row }));
}

/** Also used by a host when a stored block is unsupported in that view. */
export function DelegationChildRowNotice({
  partial = false,
}: {
  readonly partial?: boolean;
}): JSX.Element {
  return (
    <Notice intent="neutral" surface="none">
      {partial && <span>Partial: </span>}
      Part of this step isn't shown here.
    </Notice>
  );
}
