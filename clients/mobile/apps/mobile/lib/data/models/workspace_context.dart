/// The navigation context the user works in: Personal, or one organization
/// they belong to (CAN-4429), mirroring the shared `WorkspaceContext`.
///
/// A navigation fact only. It scopes which projects and chats are listed and
/// never grants access. It comes from the user's choice or the work's owner,
/// never from the order of a membership list
/// (`docs/shared-resource-authorization.md#organization-decision-sources`).
final class WorkspaceContext {
  const WorkspaceContext.personal() : organizationId = null;

  const WorkspaceContext.organization(String this.organizationId);

  /// The organization's id; null for Personal.
  final String? organizationId;

  bool get isPersonal => organizationId == null;

  @override
  bool operator ==(Object other) =>
      other is WorkspaceContext && other.organizationId == organizationId;

  @override
  int get hashCode => organizationId.hashCode;

  @override
  String toString() => isPersonal
      ? 'WorkspaceContext.personal()'
      : 'WorkspaceContext.organization($organizationId)';
}

/// How a workspace context selection ended (CAN-4429).
enum WorkspaceContextSelection {
  /// The context is active and saved for this account.
  saved,

  /// The context is active until restart; saving it failed.
  unsaved,

  /// The account does not belong to the organization; nothing changed.
  refused,

  /// A newer selection was made before this one finished saving.
  superseded,
}
