'use client';

import { createContext, useContext } from 'react';

/**
 * How an activity section draws its item rows (a script, a hook, an MCP
 * server). `comfortable` is the Side Panel's bordered item card. `compact`
 * is for a section opened inside another surface, the Activity card: plain
 * rows at the card's own row height and text style, so the section reads
 * as a list under its heading instead of cards inside a card.
 */
export type ActivityItemDensity = 'comfortable' | 'compact';

export const ActivityItemDensityContext =
  createContext<ActivityItemDensity>('comfortable');

export function useActivityItemDensity(): ActivityItemDensity {
  return useContext(ActivityItemDensityContext);
}

/**
 * The compact item row: no border or fill, the shared list-row hover, and
 * the card's 28px minimum height and small text style. Callers add the
 * display (`flex` or `grid`).
 */
export const COMPACT_ACTIVITY_ITEM_CLASS_NAME =
  'min-h-7 w-full items-center gap-2 rounded-md px-2 py-0.5 text-left text-xs hover:bg-subtle';
