import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/desktop/repository.dart';
import 'package:mobile/device_link/protocol.dart';
import 'desktop_link_recovery.dart';

enum DesktopLinkPhase {
  disconnected,
  connecting,
  pairing,
  connected,
  reconnecting,
  failed,
}

final class DesktopLinkModel extends ChangeNotifier {
  DesktopLinkModel(
    this.repository, {
    this.createStopwatch = Stopwatch.new,
    Timer Function(Duration, void Function()) createTimer = Timer.new,
  }) {
    _recovery = DesktopLinkRecovery(
      attempt: () => _connect(recovering: true),
      onExpired: () {
        debugPrint('Computer connection did not recover within a minute.');
        recoveryExpired = true;
        unawaited(_drop());
      },
      createTimer: createTimer,
    );
    _subscription = repository.events.listen((event) {
      if (_disposed) return;
      if (event['kind'] == 'closed') {
        if (phase == DesktopLinkPhase.connected &&
            !_suspended &&
            _target != null) {
          _revision++;
          phase = DesktopLinkPhase.reconnecting;
          error = null;
          debugPrint(
            'Computer connection lost: ${event['reason'] ?? 'unknown reason'}',
          );
          _outage = createStopwatch()..start();
          _recovery.start();
        } else if (!_recovery.active) {
          // A close during a handshake belongs to the pending connect. Its
          // result must still settle the attempt rather than invalidate it.
          if (!busy) phase = DesktopLinkPhase.disconnected;
        }
        code = null;
      } else if (event['name'] == 'ipc.push') {
        pushes++;
      }
      notifyListeners();
    });
  }
  final DesktopLinkConnection repository;
  final Stopwatch Function() createStopwatch;
  late final DesktopLinkRecovery _recovery;
  bool recoveryExpired = false;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  DesktopLinkPhase phase = DesktopLinkPhase.disconnected;
  String? code, error;
  Map<String, dynamic>? host;
  int pushes = 0;
  Duration? roundTrip;
  Stopwatch? _outage;
  ({String peerDeviceId, DesktopTokenProvider fetchToken})? _target;
  int _revision = 0;
  bool _disposed = false, _suspended = false, _resume = false;
  bool get busy =>
      phase == DesktopLinkPhase.connecting ||
      phase == DesktopLinkPhase.pairing ||
      reconnecting;
  bool get reconnecting => phase == DesktopLinkPhase.reconnecting;
  bool get canReconnect => _target != null;
  String describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : 'The connection could not complete. Try again.';
  Future<void> pasteCredentials(String? value) async {
    if (busy || _disposed) return;
    try {
      final credentials = DesktopRelayCredentials.parse(value ?? '');
      _target = (
        peerDeviceId: credentials.peerDeviceId,
        fetchToken: (id) => fetchDesktopRelayToken(credentials, id),
      );
    } catch (cause) {
      error = describe(cause);
      notifyListeners();
      return;
    }
    await reconnect();
  }

  Future<void> connectWith({
    required String peerDeviceId,
    required DesktopTokenProvider fetchToken,
  }) async {
    if (busy || _disposed) return;
    _target = (peerDeviceId: peerDeviceId, fetchToken: fetchToken);
    await reconnect();
  }

  Future<void> reconnect() async {
    if (busy || _disposed) return;
    recoveryExpired = false;
    await _connect();
  }

  Future<bool> _connect({bool recovering = false}) async {
    final target = _target;
    if (target == null || _disposed || _suspended) return false;
    if (recovering && !_recovery.active) return false;
    final revision = ++_revision;
    phase = recovering
        ? DesktopLinkPhase.reconnecting
        : DesktopLinkPhase.connecting;
    error = null;
    code = null;
    if (!recovering) host = null;
    notifyListeners();
    final watch = createStopwatch()..start();
    try {
      final info = await repository.connect(
        peerDeviceId: target.peerDeviceId,
        fetchToken: target.fetchToken,
        allowPairing: !recovering,
        onCode: (value) {
          if (_disposed || revision != _revision) return;
          code = '${value.substring(0, 3)} ${value.substring(3)}';
          phase = DesktopLinkPhase.pairing;
          notifyListeners();
        },
      );
      if (_disposed || revision != _revision) return false;
      _recovery.cancel();
      if (recovering && _outage != null) {
        debugPrint(
          'Computer connection restored after '
          '${_outage!.elapsedMilliseconds} ms.',
        );
      }
      _outage = null;
      host = info;
      code = null;
      phase = DesktopLinkPhase.connected;
      roundTrip = watch.elapsed;
    } catch (cause) {
      if (_disposed || revision != _revision) return false;
      if (cause is DesktopRelayAccessException) {
        _recovery.cancel();
        recoveryExpired = true;
        error = describe(cause);
        host = null;
        phase = DesktopLinkPhase.failed;
      } else {
        if (!recovering) error = describe(cause);
        phase = recovering
            ? DesktopLinkPhase.reconnecting
            : DesktopLinkPhase.failed;
      }
      code = null;
    }
    if (!_disposed && revision == _revision) notifyListeners();
    return phase == DesktopLinkPhase.connected;
  }

  /// Retries a recovering connection now, for example when its computer
  /// comes back online, instead of waiting for the next scheduled attempt.
  void retryNow() {
    if (reconnecting && !_suspended) _recovery.retryNow();
  }

  Future<void> refresh() async {
    if (phase != DesktopLinkPhase.connected) return;
    final revision = _revision;
    final watch = createStopwatch()..start();
    try {
      final info = await repository.readHostInfo();
      if (!_disposed && revision == _revision) {
        host = info;
        roundTrip = watch.elapsed;
        error = null;
        notifyListeners();
      }
    } catch (cause) {
      if (!_disposed && revision == _revision) {
        error = describe(cause);
        notifyListeners();
      }
    }
  }

  Future<void> disconnectAndClear() async {
    await disconnect();
    _target = null;
    if (!_disposed) notifyListeners();
  }

  Future<void> disconnect() async {
    _resume = false;
    await _drop();
  }

  Future<void> _drop() async {
    _recovery.cancel();
    _outage = null;
    _revision++;
    phase = DesktopLinkPhase.disconnected;
    code = null;
    host = null;
    if (!_disposed) notifyListeners();
    await repository.disconnect();
  }

  Future<void> forget() async {
    await disconnect();
    try {
      await repository.forget();
    } catch (cause) {
      if (!_disposed) {
        error = describe(cause);
        notifyListeners();
      }
    }
  }

  Future<void> suspend() async {
    if (_suspended) return;
    _suspended = true;
    _resume = phase == DesktopLinkPhase.connected || reconnecting;
    if (!_resume) {
      await _drop();
      return;
    }
    _recovery.cancel();
    _revision++;
    phase = DesktopLinkPhase.reconnecting;
    code = null;
    if (!_disposed) notifyListeners();
    await repository.disconnect();
  }

  Future<void> resume() async {
    _suspended = false;
    if (!_resume || _disposed) return;
    _resume = false;
    _recovery.start();
  }

  @override
  void dispose() {
    _disposed = true;
    _recovery.cancel();
    _revision++;
    _target = null;
    unawaited(_subscription?.cancel());
    unawaited(repository.dispose());
    super.dispose();
  }
}
