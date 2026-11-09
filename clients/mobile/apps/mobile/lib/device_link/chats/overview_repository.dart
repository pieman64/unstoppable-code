import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';
import 'scope_state.dart';

/// Cowork work entries occupy chat scopes but have no worktree inventory row.
/// Read their canonical tab/runtime state using the live catalog's targets.
final class DeviceChatOverviewRepository {
  DeviceChatOverviewRepository(this.ipc, {this.onChanged});
  final DesktopIpc ipc;
  final void Function()? onChanged;
  Map<String, DeviceChatRef> _targets = {};
  final _scopes = <String, ({int revision, DeviceChatScopeState state})>{};
  int _generation = 0;

  static String _key(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';
  DeviceChatRef? target(String key) => _targets[key];

  bool unread(DeviceChatRef ref) {
    final tab =
        _scopes[_key(ref)]?.state.tab(ref.id) ?? const <String, dynamic>{};
    return _visible(tab) && tab['unread'] == true;
  }

  bool working(DeviceChatRef ref) {
    final scope = _scopes[_key(ref)]?.state;
    return scope != null &&
        _visible(scope.tab(ref.id)) &&
        scope.running(ref.id);
  }

  static bool _visible(Map<String, dynamic> tab) =>
      tab.isNotEmpty && tab['kind'] != 'file' && tab['archivedAt'] == null;

  /// Retain display-only statuses while retiring reads from the old session.
  void pause() {
    _generation++;
  }

  void invalidate() {
    _generation++;
    _targets = {};
    _scopes.clear();
  }

  Future<void> refresh(Iterable<DeviceChatRef> chats) async {
    final generation = ++_generation;
    _targets = {for (final chat in chats) _key(chat): chat};
    _scopes.removeWhere((key, _) => !_targets.containsKey(key));
    onChanged?.call();
    final targets = _targets.values.toList();
    // Match worktree hydration's bound below the session's eight-request cap.
    for (var offset = 0; offset < targets.length; offset += 3) {
      if (generation != _generation) return;
      await Future.wait(targets.skip(offset).take(3).map(load));
    }
  }

  Future<void> load(DeviceChatRef ref) async {
    final generation = _generation, key = _key(ref);
    if (!_targets.containsKey(key)) return;
    try {
      final snapshot = deviceLinkObject(
        deviceChatDto(await ipc.invoke('chat:get-state', [ref.scope])),
      );
      if (generation != _generation) return;
      final revision = snapshot['revision'];
      if (revision is! int || (_scopes[key]?.revision ?? -1) > revision) {
        return;
      }
      final state = DeviceChatScopeState()..hydrate(snapshot);
      _scopes[key] = (revision: revision, state: state);
      onChanged?.call();
    } catch (_) {
      // Keep the last desktop observation until a later refresh succeeds.
      // A status read must not prevent opening the chat itself.
    }
  }
}
