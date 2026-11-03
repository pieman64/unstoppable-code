import 'package:mobile/data/models/workspace_context.dart';

/// Account-supplied display name, kept separate from the context's identity
/// so a name change cannot change ownership or scope comparisons.
final class WorkspaceContextLabel {
  const WorkspaceContextLabel(this.value);

  final String value;

  static String fallback(WorkspaceContext? context) => context == null
      ? 'your current context'
      : context.isPersonal
      ? 'Personal'
      : 'this organization';
}
