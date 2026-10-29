/**
 * Whether the viewer may remove a resource's public link. The author can
 * (update), and so can an organization admin who may delete a departed
 * creator's share but not edit it. An unknown detail defers to the dialog,
 * which only offers the action for an existing public share.
 *
 * This only decides whether to show the action; the server still authorizes
 * the revoke itself.
 */
export function canManagePublicLink(
  detail: { canUpdate?: boolean; canDelete?: boolean } | null | undefined,
): boolean {
  if (!detail) return true;
  return detail.canUpdate !== false || detail.canDelete !== false;
}
