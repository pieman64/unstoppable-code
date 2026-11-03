import 'package:mobile/data/models/workspace_context.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists each account's chosen [WorkspaceContext] (CAN-4429), so the choice
/// survives restarts and one account never inherits another's.
///
/// Mirrors `ThemePreferenceStore`: an interface with a `shared_preferences`
/// implementation and an in-memory one for tests and the mock path. The choice
/// is a non-sensitive navigation preference, so plain preferences suffice.
abstract interface class WorkspaceContextStore {
  /// The saved context for [accountId], or null when nothing usable is saved.
  Future<WorkspaceContext?> read(String accountId);

  /// Saves [context] for [accountId].
  Future<void> write(String accountId, WorkspaceContext context);
}

const String _personal = 'personal';
const String _organizationPrefix = 'organization:';

String _encode(WorkspaceContext context) => switch (context.organizationId) {
  null => _personal,
  final organizationId => '$_organizationPrefix$organizationId',
};

/// Unknown or malformed values read as nothing saved, so a corrupt or future
/// value never throws.
WorkspaceContext? _decode(String? value) {
  if (value == _personal) return const WorkspaceContext.personal();
  if (value == null || !value.startsWith(_organizationPrefix)) return null;
  final organizationId = value.substring(_organizationPrefix.length);
  return organizationId.isEmpty
      ? null
      : WorkspaceContext.organization(organizationId);
}

/// [WorkspaceContextStore] backed by `shared_preferences`, keyed by account
/// within [namespace] (the API environment), since user ids are only unique
/// per server.
final class SharedPrefsWorkspaceContextStore implements WorkspaceContextStore {
  const SharedPrefsWorkspaceContextStore({required this.namespace});

  final String namespace;

  String _key(String accountId) =>
      'canopy.workspace_context.$namespace.$accountId';

  @override
  Future<WorkspaceContext?> read(String accountId) async {
    final prefs = await SharedPreferences.getInstance();
    return _decode(prefs.getString(_key(accountId)));
  }

  @override
  Future<void> write(String accountId, WorkspaceContext context) async {
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setString(_key(accountId), _encode(context))) {
      throw StateError('The workspace context was not saved.');
    }
  }
}

/// In-memory [WorkspaceContextStore] for tests and the mock path.
final class InMemoryWorkspaceContextStore implements WorkspaceContextStore {
  final Map<String, WorkspaceContext> _saved = {};

  @override
  Future<WorkspaceContext?> read(String accountId) async => _saved[accountId];

  @override
  Future<void> write(String accountId, WorkspaceContext context) async {
    _saved[accountId] = context;
  }
}
