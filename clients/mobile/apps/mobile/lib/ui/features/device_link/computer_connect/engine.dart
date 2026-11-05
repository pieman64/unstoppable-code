import 'package:mobile/data/models/chat_drafts.dart';
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/desktop/hub.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/desktop/repository.dart';
import '../chats_view_model.dart';
import '../desktop_link_model.dart';
import 'controller.dart';

/// One account/environment's registry. Selection is navigation, not ownership:
/// changing it never swaps a repository underneath a mounted chat or closes a
/// different computer. Every entry owns its projections, drafts and requests.
final class ComputerConnectEngine extends ChangeNotifier {
  ComputerConnectEngine(
    this.hub, {
    this.drafts,
    this.createConnection = DesktopLinkRepository.shared,
    this.createRecoveryTimer = Timer.new,
  }) {
    _selected = _create();
  }
  final DesktopLinkHub hub;
  final ChatDraftStore? drafts;
  final DesktopLinkConnection Function(DesktopLinkHub) createConnection;
  final Timer Function(Duration, void Function()) createRecoveryTimer;
  final _sessions = <String, ComputerConnectController>{};
  late ComputerConnectController _selected;
  bool _disposed = false, _foreground = true;
  Future<void> _lifecycle = Future.value();
  ComputerConnectController get selected => _selected;
  Map<String, ComputerConnectController> get sessions =>
      Map.unmodifiable(_sessions);
  String? get selectedId => _sessions.entries
      .where((entry) => identical(entry.value, _selected))
      .firstOrNull
      ?.key;
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  ComputerConnectController _create() {
    final repository = createConnection(hub);
    final chats = DeviceChatsViewModel(
      connection: DesktopLinkModel(
        repository,
        createTimer: createRecoveryTimer,
      ),
      chats: DeviceChatsRepository(repository),
    );
    return ComputerConnectController(chats, connectComputer: connect)
      ..addListener(_changed);
  }

  Future<void> connect(DesktopRelayPeer peer, DesktopTokenProvider tokens) =>
      connectDevice(peer.id, tokens);

  void rememberComputer(String peerId) {
    final prior = _selected;
    _sessions.putIfAbsent(
      peerId,
      () => _sessions.values.contains(prior) ? _create() : prior,
    );
  }

  Future<void> connectDevice(
    String peerId,
    DesktopTokenProvider tokens, {
    bool selectComputer = true,
  }) async {
    if (_disposed || !_foreground) return;
    rememberComputer(peerId);
    final target = _sessions[peerId]!;
    if (drafts case final store?) target.chats.bindDrafts(peerId, store);
    if (selectComputer) _selected = target;
    _changed();
    if (!target.chats.online && !target.chats.connection.busy) {
      await target.chats.connection.connectWith(
        peerDeviceId: peerId,
        fetchToken: tokens,
      );
    }
  }

  void select(String peerId) {
    final target = _sessions[peerId];
    if (_disposed || target == null || identical(target, _selected)) return;
    _selected = target;
    _changed();
  }

  Iterable<ComputerConnectController> get _all => {
    _selected,
    ..._sessions.values,
  };
  Future<void> _afterLifecycle(Future<void> Function() action) {
    final next = _lifecycle.then((_) async {
      if (!_disposed) await action();
    });
    // A failed transition must not poison later lifecycle requests.
    _lifecycle = next.catchError((Object _) {});
    return next;
  }

  Future<void> suspend() {
    _foreground = false;
    // Invalidate active handshakes immediately, even if a foreground attempt
    // is still awaiting the network. Close the account socket in order.
    final dropped = Future.wait(_all.map((c) => c.chats.connection.suspend()));
    return _afterLifecycle(() async {
      await dropped;
      await hub.disconnect();
    });
  }

  Future<void> resume() {
    _foreground = true;
    return _afterLifecycle(() async {
      if (!_foreground) return;
      await Future.wait(_all.map((c) => c.chats.connection.resume()));
    });
  }

  @override
  void dispose() {
    _disposed = true;
    for (final controller in _all) {
      controller.removeListener(_changed);
      controller.dispose();
      controller.chats.dispose();
    }
    _sessions.clear();
    unawaited(hub.dispose());
    super.dispose();
  }
}
