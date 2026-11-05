import 'dart:async';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/device_link/worktrees/creation.dart';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/device_link/protocol.dart';
import '../chats_view_model.dart';

/// Account discovery and overview lifetime belong only to Computer connect.
class ComputerConnectController extends ChangeNotifier {
  ComputerConnectController(
    this.chats, {
    this.connectComputer,
    this.createTimer = Timer.new,
  }) : worktrees = DeviceWorktreesRepository(chats.chats.ipc) {
    chats.connection.addListener(_connectionChanged);
    _events = chats.chats.ipc.events.listen(_event);
    _connectionChanged();
  }
  final DeviceChatsViewModel chats;
  final Timer Function(Duration, void Function()) createTimer;
  final Future<void> Function(DesktopRelayPeer, DesktopTokenProvider)?
  connectComputer;
  final DeviceWorktreesRepository worktrees;
  late final worktreeCreator = DeviceWorktreeCreator(chats.chats.ipc)
    ..setConnected(chats.online);
  List<DesktopRelayPeer> computers = [];
  bool discovering = false, loading = false;
  String? error;
  DesktopTokenProvider? _tokens;
  bool _disposed = false, _online = false, _overview = true;
  int _generation = 0;
  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _refresh;
  final _pendingScopes = <String>{};
  bool _readingScope = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> findComputers(String origin, String key) async {
    if (discovering || chats.online) return;
    try {
      final credentials = DesktopRelayCredentials.parse(
        jsonEncode({
          'apiUrl': origin.trim(),
          'apiKey': key.trim(),
          'peerDeviceId': 'AAAAAAAAAAAAAAAAAAAAAA',
        }),
      );
      await discoverWith((id) => fetchDesktopRelayToken(credentials, id));
    } catch (cause) {
      error = _describe(cause);
      _notify();
    }
  }

  Future<void> discoverWith(DesktopTokenProvider tokens) async {
    if (discovering || chats.online) return;
    final generation = ++_generation;
    discovering = true;
    computers = [];
    error = null;
    _notify();
    DesktopRelay? relay;
    try {
      final identity = await chats.connection.repository.identity();
      relay = await chats.connection.repository.hub.relay(tokens);
      if (_disposed || generation != _generation) return;
      computers =
          relay.peers.values
              .where((p) => p.acceptsControl && p.id != identity.deviceId)
              .toList()
            ..sort((a, b) => a.name.compareTo(b.name));
      _tokens = tokens;
    } catch (cause) {
      if (generation == _generation) error = _describe(cause);
    } finally {
      if (generation == _generation) {
        discovering = false;
        _notify();
      }
    }
  }

  Future<void> connect(DesktopRelayPeer computer) async {
    final tokens = _tokens;
    if (tokens == null ||
        discovering ||
        chats.connection.busy ||
        !computers.contains(computer)) {
      return;
    }
    computers = [];
    if (connectComputer case final connect?) {
      await connect(computer, tokens);
      return;
    }
    await chats.connection.connectWith(
      peerDeviceId: computer.id,
      fetchToken: tokens,
    );
    _notify();
  }

  void _connectionChanged() {
    final online = chats.online;
    worktreeCreator.setConnected(online);
    if (_online != online) {
      _online = online;
      if (online && _overview) {
        unawaited(watchOverview());
      } else {
        worktrees.invalidate();
        loading = false;
        _refresh?.cancel();
      }
    }
    _notify();
  }

  void _event(Map<String, dynamic> message) {
    if (!_overview || !chats.online || message['name'] != 'ipc.push') return;
    final push = message['payload'];
    if (push is! Map) return;
    if (push['channel'] == 'chat:state-changed' &&
        push['args'] is List &&
        (push['args'] as List).isNotEmpty) {
      final event = (push['args'] as List).first;
      if (event is Map &&
          (event['changes'] as List? ?? []).whereType<Map>().any(
            (change) => change['type'] == 'runtime.patched',
          )) {
        _pendingScopes.add('${event['projectId']}/${event['worktreeId']}');
        unawaited(_readScopes());
      }
    }
    if ([
      'worktrees:file-changed',
      'workspace:worktrees-updated',
      'chat:state-changed',
    ].contains(push['channel'])) {
      // Re-read authoritative summaries after changes, once the burst settles.
      // No polling remains active while the app is suspended/disconnected.
      _refresh?.cancel();
      _refresh = createTimer(
        const Duration(seconds: 2),
        () => unawaited(refresh()),
      );
    }
  }

  Future<void> _readScopes() async {
    if (_readingScope) return;
    _readingScope = true;
    try {
      while (!_disposed &&
          _overview &&
          chats.online &&
          _pendingScopes.isNotEmpty) {
        final key = _pendingScopes.first;
        _pendingScopes.remove(key);
        final worktree = worktrees.worktrees
            .where((w) => w.key == key)
            .firstOrNull;
        if (worktree != null) {
          await worktrees.load(worktree);
          _notify();
        }
      }
    } finally {
      _readingScope = false;
    }
  }

  Future<void> refresh() async {
    if (!chats.online || loading) return;
    loading = true;
    error = null;
    _notify();
    try {
      await Future.wait([worktrees.refresh(), chats.chats.refreshCatalog()]);
    } catch (cause) {
      error = _describe(cause);
    } finally {
      loading = false;
      _notify();
    }
  }

  WorktreeActivityContext? activityContext(DeviceChatRef ref) {
    final project = worktrees.projects
        .where((p) => p.id == ref.projectId)
        .firstOrNull;
    chats.activity.setWorkspaceKind(
      ref.projectId,
      project?.type ?? 'single-repo',
    );
    return worktrees.codeProjectIds.contains(ref.projectId)
        ? WorktreeActivityContext(
            workspaceLocalId: ref.projectId,
            localId: ref.worktreeId,
          )
        : null;
  }

  void enterChat() {
    _overview = false;
    _pendingScopes.clear();
    _refresh?.cancel();
  }

  Future<void> watchOverview() async {
    _overview = true;
    if (!chats.online) return;
    try {
      await chats.chats.ipc.invoke('chat:set-state-scopes', [
        {'kind': 'all'},
      ]);
      await refresh();
    } catch (cause) {
      error = _describe(cause);
      _notify();
    }
  }

  Future<void> restoreOverview(int selectionGeneration) async {
    if (_disposed || chats.chats.selectionGeneration != selectionGeneration) {
      return;
    }
    await chats.leaveChat(expectedGeneration: selectionGeneration);
    if (_disposed || chats.chats.selectionGeneration != selectionGeneration + 1) {
      return;
    }
    await watchOverview();
  }

  Future<void> disconnect() async {
    _generation++;
    _tokens = null;
    computers = [];
    discovering = false;
    await chats.connection.disconnectAndClear();
    _notify();
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : 'Could not read your computer. Try again.';
  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _refresh?.cancel();
    worktrees.invalidate();
    unawaited(worktreeCreator.dispose());
    chats.connection.removeListener(_connectionChanged);
    unawaited(_events?.cancel());
    super.dispose();
  }
}
