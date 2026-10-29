export type ArchivedContainerState = 'archived' | 'deleted';

export function getArchivedContainerStateLabel(
  state: ArchivedContainerState,
): 'Archived' | 'Deleted' {
  return state === 'archived' ? 'Archived' : 'Deleted';
}

export function getArchivedContainerStateDescription(
  state: ArchivedContainerState,
  formattedExpiresAt: string,
): string {
  return state === 'archived'
    ? 'Kept until you delete it. Delete it to start the retention countdown again.'
    : `Removed on ${formattedExpiresAt} unless you restore or archive it first.`;
}

/**
 * Case-insensitive substring match used by the "Archived and deleted"
 * overviews to filter rows by the search box. `query` must already be
 * trimmed and lower-cased; an empty query matches everything.
 */
export function matchesArchivedQuery(
  query: string,
  ...fields: (string | undefined)[]
): boolean {
  if (query.length === 0) return true;
  return fields.some((field) => field?.toLowerCase().includes(query) === true);
}
