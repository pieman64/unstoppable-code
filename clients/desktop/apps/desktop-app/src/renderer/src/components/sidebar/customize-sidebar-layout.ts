import type { SidebarNavLayout } from '@canopy/desktop-shared/types';

/**
 * Sentinel entry representing the "More" divider inside the editable entry
 * list. Its position in the list determines `moreStartIndex`: everything above
 * it renders in main nav, everything below it renders in the More menu.
 */
export const MORE_DIVIDER_ID = '__more__';

/**
 * Expand a persisted layout into the modal's flat editable entry list: the
 * ordered nav keys with the `MORE_DIVIDER_ID` sentinel spliced in at
 * `moreStartIndex`.
 */
export function toEntries(order: string[], moreStartIndex: number): string[] {
  const entries = [...order];
  entries.splice(moreStartIndex, 0, MORE_DIVIDER_ID);
  return entries;
}

function mergeHiddenIntoSection(
  editedKeys: string[],
  hiddenKeys: string[],
  storedSectionOrder: string[],
): string[] {
  const hiddenSet = new Set(hiddenKeys);
  const merged = [...editedKeys];
  let insertedHiddenCount = 0;

  for (const hiddenKey of hiddenKeys) {
    const storedIndex = storedSectionOrder.indexOf(hiddenKey);
    const precedingVisibleCount = storedSectionOrder
      .slice(0, storedIndex)
      .filter((key) => !hiddenSet.has(key)).length;
    const insertAt = Math.min(
      precedingVisibleCount + insertedHiddenCount,
      merged.length,
    );
    merged.splice(insertAt, 0, hiddenKey);
    insertedHiddenCount += 1;
  }

  return merged;
}

/**
 * Rebuild a full `SidebarNavLayout` from the modal's edited entry list.
 *
 * The edited list may omit keys that were hidden from the editor (a
 * `remote-control` entry, which desktop never lists). Those hidden keys keep
 * their stored section, so saving while an item is hidden cannot move it across
 * the More divider.
 */
export function buildLayoutFromEntries(
  editedEntries: string[],
  storedLayout: SidebarNavLayout,
): SidebarNavLayout {
  const dividerPos = editedEntries.indexOf(MORE_DIVIDER_ID);
  const editedMainKeys = editedEntries
    .slice(0, dividerPos)
    .filter((id) => id !== MORE_DIVIDER_ID);
  const editedMoreKeys = editedEntries
    .slice(dividerPos + 1)
    .filter((id) => id !== MORE_DIVIDER_ID);
  const hiddenKeys = storedLayout.order.filter(
    (key) => !editedEntries.includes(key),
  );
  const hiddenMainKeys = storedLayout.order.filter(
    (key, index) =>
      hiddenKeys.includes(key) && index < storedLayout.moreStartIndex,
  );
  const hiddenMoreKeys = storedLayout.order.filter(
    (key, index) =>
      hiddenKeys.includes(key) && index >= storedLayout.moreStartIndex,
  );
  const storedMainOrder = storedLayout.order.slice(
    0,
    storedLayout.moreStartIndex,
  );
  const storedMoreOrder = storedLayout.order.slice(storedLayout.moreStartIndex);

  const mainNav = mergeHiddenIntoSection(
    editedMainKeys,
    hiddenMainKeys,
    storedMainOrder,
  );
  const more = mergeHiddenIntoSection(
    editedMoreKeys,
    hiddenMoreKeys,
    storedMoreOrder,
  );
  const order = [...mainNav, ...more];

  return { order, moreStartIndex: mainNav.length };
}
