import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/desktop/saved_connection.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/store.dart';
import '../desktop_link_model.dart';
import 'engine.dart';

/// Owns one signed-in account's setup, saved computers and foreground recovery.
/// Only an explicit connect can pair. Recovery never grants new trust.
final class ComputerConnectAccount extends ChangeNotifier {
  ComputerConnectAccount({
    required this.engine,
    required this.store,
    required String accountId,
    required String origin,
    required this.createCredential,
    this.fetchToken = fetchDesktopRelayToken,
    this.scheduleRetry = Timer.new,
  }) : saved = SavedComputerConnection(accountId: accountId, origin: origin) {
    engine.addListener(_engineChanged);
  }
  final ComputerConnectEngine engine;
  final DeviceLinkStore store;
  final SavedComputerConnection saved;
  final Future<ComputerConnectCredential> Function() createCredential;
  final Future<DesktopRelayToken> Function(DesktopRelayCredentials, String)
  fetchToken;
  final Timer Function(Duration, void Function()) scheduleRetry;
  final peers = <String, DesktopRelayPeer>{};
  bool ready = false, busy = false, accessDenied = false;
  int? accessStatus;
  String? error;
  bool _disposed = false, _foreground = true, _unreadable = false;
  bool _credentialNeedsSave = false;
  int _attempt = 0;
  Timer? _retry;
  StreamSubscription<void>? _peerChanges, _relayClosed;
  DesktopRelay? _relay;
  Future<void> _writes = Future.value();
  List<SavedComputer> get computers => saved.computers.values.toList();
  String? get selectedName => saved.computers[engine.selectedId]?.name;
  bool get setupUncertain =>
      saved.creatingCredential && saved.credential == null;
  bool get hasCredential => saved.credential != null;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _save() {
    final value = saved.encode();
    final next = _writes.then((_) => store.write(value));
    _writes = next.catchError((Object _) {});
    return next;
  }

  Future<void> restore() async {
    if (ready || busy || _disposed) return;
    busy = true;
    try {
      final record = await store.read();
      if (_disposed) return;
      if (record != null) saved.restore(record);
      if (setupUncertain) {
        error = 'Setup was interrupted. Try again to finish connecting.';
      }
      for (final computer in computers) {
        engine.rememberComputer(computer.id);
      }
      if (saved.selectedId case final id?) engine.select(id);
      ready = true;
    } catch (_) {
      _unreadable = true;
      error =
          'Saved connection settings could not be read. They were preserved. Try again.';
    } finally {
      busy = false;
      _notify();
    }
    if (!_disposed && ready && hasCredential && !setupUncertain) {
      await findComputers();
    }
  }

  DesktopRelayCredentials get _credentials => DesktopRelayCredentials(
    apiUrl: Uri.parse(saved.origin),
    apiKey: saved.credential!.token,
    peerDeviceId: 'AAAAAAAAAAAAAAAAAAAAAA',
  );
  Future<DesktopRelayToken> _token(String id) async {
    if (_disposed || !_foreground) {
      throw const DeviceLinkException('Connection cancelled.');
    }
    if (accessDenied) throw DesktopRelayAccessException(accessStatus ?? 401);
    final credential = saved.credential;
    try {
      return await fetchToken(_credentials, id);
    } on DesktopRelayAccessException catch (cause) {
      if (!_disposed &&
          _foreground &&
          identical(saved.credential, credential)) {
        _denyAccess(cause);
      }
      rethrow;
    }
  }

  void _denyAccess(DesktopRelayAccessException cause) {
    accessDenied = true;
    accessStatus = cause.statusCode;
    _retry?.cancel();
    _retry = null;
    error = cause.statusCode == 401
        ? 'Your connection access expired. Try again to renew it.'
        : 'Computer connection is unavailable for this account. Check your account access and try again.';
    _notify();
  }

  void _resetRecovery() {
    for (final computer in computers.where((computer) => computer.reconnect)) {
      engine.sessions[computer.id]?.chats.connection.recoveryExpired = false;
    }
  }

  Future<void> findComputers() async {
    if (busy || _disposed || !_foreground) return;
    if (!ready || _unreadable) {
      _unreadable = false;
      await restore();
      return;
    }
    if (setupUncertain) {
      error = 'Setup was interrupted. Try again to finish connecting.';
      _notify();
      return;
    }
    // Automatic discovery stops at accessDenied. A tap or foreground resume
    // may recheck account availability with the existing key; 401 needs renewal.
    if (accessDenied && accessStatus != 401) {
      accessDenied = false;
      accessStatus = null;
      _resetRecovery();
    }
    _retry?.cancel();
    busy = true;
    error = null;
    _notify();
    try {
      if (!hasCredential) {
        // This marker survives an uncertain create response. Never silently
        // repeat a non-idempotent account mutation on restart or retry.
        saved.creatingCredential = true;
        try {
          await _save();
        } catch (_) {
          saved.creatingCredential = false;
          rethrow;
        }
        if (_disposed || !_foreground) {
          saved.creatingCredential = false;
          await _save();
          return;
        }
        final credential = await createCredential();
        saved.credential = credential;
        saved.creatingCredential = false;
        _credentialNeedsSave = true;
        // Persist a returned secret even if the screen/account was disposed
        // while the request was in flight. Its storage is account-scoped.
        await _save();
        _credentialNeedsSave = false;
      } else if (_credentialNeedsSave) {
        await _save(); // Retry a previous storage failure without minting again.
        _credentialNeedsSave = false;
      }
      if (_disposed || !_foreground) return;
      final relay = await engine.hub.relay(_token);
      if (_disposed || !_foreground) return;
      if (!identical(relay, _relay)) {
        await _peerChanges?.cancel();
        await _relayClosed?.cancel();
        _relay = relay;
        _peerChanges = relay.peerChanges.listen((_) {
          _readPeers(relay);
          _schedule();
        });
        _relayClosed = relay.closed.listen((_) {
          peers.clear();
          _notify();
          _schedule();
        });
      }
      _readPeers(relay);
      accessDenied = false;
      accessStatus = null;
      for (final computer in computers) {
        if (_disposed || !_foreground) return;
        final connection = engine.sessions[computer.id]?.chats.connection;
        if (saved.computers[computer.id]?.reconnect != true ||
            connection?.busy == true ||
            connection?.recoveryExpired == true ||
            connection?.phase == DesktopLinkPhase.connected ||
            engine.hub.pinnedKey(computer.id) == null ||
            peers[computer.id]?.acceptsControl != true) {
          continue;
        }
        await engine.connectDevice(computer.id, _token, selectComputer: false);
      }
      if (computers.every(
        (c) => !c.reconnect || engine.sessions[c.id]?.chats.online == true,
      )) {
        _attempt = 0;
      }
    } on ComputerConnectSetupRejected catch (cause) {
      saved.creatingCredential = false;
      try {
        await _save();
        error = cause.message;
      } catch (_) {
        error = 'Could not save connection settings. Try again.';
      }
    } on DesktopRelayAccessException catch (cause) {
      _denyAccess(cause);
    } catch (cause) {
      error = setupUncertain
          ? 'Setup was interrupted. Try again to finish connecting.'
          : cause is DeviceLinkException
          ? cause.message
          : 'Could not connect. Your saved settings were kept. Try again.';
    } finally {
      busy = false;
      _notify();
      _schedule();
    }
  }

  void _readPeers(DesktopRelay relay) {
    if (_disposed) return;
    for (final peer in relay.peers.values) {
      if (peer.acceptsControl &&
          peers[peer.id]?.acceptsControl != true &&
          saved.computers[peer.id]?.reconnect == true) {
        engine.sessions[peer.id]?.chats.connection.recoveryExpired = false;
      }
    }
    peers
      ..clear()
      ..addAll(relay.peers);
    _notify();
  }

  void _engineChanged() {
    _notify();
    _schedule();
  }

  void _schedule() {
    if (_disposed ||
        !_foreground ||
        busy ||
        accessDenied ||
        !hasCredential ||
        _unreadable ||
        setupUncertain ||
        _retry?.isActive == true) {
      return;
    }
    final needsDiscovery =
        _relay?.isClosed == true &&
        computers.any((computer) => computer.reconnect);
    if (!needsDiscovery &&
        !computers.any(
          (c) =>
              c.reconnect &&
              engine.sessions[c.id]?.chats.online != true &&
              engine.sessions[c.id]?.chats.connection.busy != true &&
              engine.sessions[c.id]?.chats.connection.recoveryExpired != true,
        )) {
      return;
    }
    const delays = [2, 5, 15, 30];
    final delay = delays[_attempt.clamp(0, delays.length - 1)];
    _attempt++;
    _retry = scheduleRetry(Duration(seconds: delay), () {
      _retry = null;
      unawaited(findComputers());
    });
  }

  Future<void> connect(String id) async {
    if (busy || _disposed || !_foreground || !hasCredential) return;
    final peer = peers[id];
    if (peer == null || !peer.acceptsControl) {
      error = 'This computer is offline or Remote access is off.';
      _notify();
      return;
    }
    busy = true;
    error = null;
    _notify();
    try {
      await engine.connect(peer, _token);
      if (_disposed || !_foreground) return;
      if (engine.sessions[id]?.chats.online == true) {
        saved.computers[id] = SavedComputer(id, peer.name);
        saved.selectedId = id;
        await _save();
      }
    } catch (_) {
      error = 'Could not save this connection. Try again.';
    } finally {
      busy = false;
      _notify();
      _schedule();
    }
  }

  Future<void> disconnect(String id) async {
    final computer = saved.computers[id];
    if (_disposed || computer == null) return;
    // Persist intent before closing. A cold start must honor a manual disconnect.
    saved.computers[id] = SavedComputer(id, computer.name, reconnect: false);
    try {
      await _save();
      await engine.sessions[id]?.disconnect();
    } catch (_) {
      saved.computers[id] = computer;
      error = 'Could not save the disconnect. Try again.';
    }
    _notify();
  }

  Future<void> forget(String id) async {
    if (_disposed) return;
    await disconnect(id);
    if (saved.computers[id]?.reconnect != false) return;
    try {
      await engine.hub.forget(id);
      saved.computers.remove(id);
      if (saved.selectedId == id) saved.selectedId = null;
      await _save();
    } catch (_) {
      error = 'Could not forget this computer. Try again.';
    }
    _notify();
  }

  /// Explicit recovery only: a tap on Try again, never an automatic retry.
  Future<void> setUpAgain() async {
    if (busy || _disposed) return;
    busy = true;
    _notify();
    try {
      // Invalidate attempts using the old credential before clearing retry blocks.
      await Future.wait(
        engine.sessions.values.map(
          (session) => session.chats.connection.disconnect(),
        ),
      );
      if (_disposed) return;
      _resetRecovery();
      saved.credential = null;
      saved.creatingCredential = false;
      accessDenied = false;
      accessStatus = null;
      await _save();
      await engine.hub.disconnect();
    } catch (_) {
      error = 'Could not save connection settings. Try again.';
      return;
    } finally {
      busy = false;
      _notify();
    }
    await findComputers();
  }

  Future<void> suspend() async {
    _foreground = false;
    _retry?.cancel();
    _retry = null;
    await engine.suspend();
  }

  Future<void> resume() async {
    _foreground = true;
    _resetRecovery();
    await engine.resume();
    if (!_disposed) await findComputers();
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    engine.removeListener(_engineChanged);
    unawaited(_peerChanges?.cancel());
    unawaited(_relayClosed?.cancel());
    super.dispose();
  }
}
