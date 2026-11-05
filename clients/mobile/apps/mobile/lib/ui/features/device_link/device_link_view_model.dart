import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/repository.dart';

enum DeviceLinkPhase {
  disconnected,
  connecting,
  awaitingApproval,
  connected,
  failed,
}

typedef DeviceLinkTestMessage = ({String text, bool fromPeer});

final class DeviceLinkViewModel extends ChangeNotifier {
  DeviceLinkViewModel(
    this._repository, {
    this.createStopwatch = Stopwatch.new,
  }) {
    _subscription = _repository.events.listen((event) {
      if (_disposed) return;
      if (event['kind'] == 'closed') {
        _revision++;
        phase = DeviceLinkPhase.disconnected;
        sending = false;
        pairingCode = null;
        notifyListeners();
      } else if (event['name'] == 'connection.message') {
        pushCount++;
        notifyListeners();
      }
    });
  }

  final DeviceLinkRepository _repository;
  final Stopwatch Function() createStopwatch;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  DeviceLinkPhase phase = DeviceLinkPhase.disconnected;
  String? pairingCode;
  String? peerName;
  String? error;
  String? _invitation;
  bool sending = false;
  int pushCount = 0;
  Duration? lastRoundTrip;
  final messages = <DeviceLinkTestMessage>[];
  int _revision = 0;
  bool _disposed = false;
  bool _resumeConnection = false;
  bool _suspended = false;

  bool get busy =>
      phase == DeviceLinkPhase.connecting ||
      phase == DeviceLinkPhase.awaitingApproval;
  bool get canReconnect => _invitation != null;

  String _describe(Object error) => error is DeviceLinkException
      ? error.message
      : 'The prototype could not complete that action. Try again.';

  void reportMissingInvitation() {
    error = 'Copy the invitation from the local desktop peer first.';
    notifyListeners();
  }

  Future<void> connect(String invitation) async {
    if (_disposed || busy) return;
    final revision = ++_revision;
    _invitation = invitation;
    error = null;
    pairingCode = null;
    phase = DeviceLinkPhase.connecting;
    notifyListeners();
    try {
      await _repository.connect(
        invitation,
        onPairingCode: (code) {
          if (_disposed || revision != _revision) return;
          pairingCode = '${code.substring(0, 3)} ${code.substring(3)}';
          phase = DeviceLinkPhase.awaitingApproval;
          notifyListeners();
        },
      );
      if (_disposed || revision != _revision) return;
      peerName = _repository.peerName;
      phase = DeviceLinkPhase.connected;
      pairingCode = null;
    } catch (cause) {
      if (_disposed || revision != _revision) return;
      error = _describe(cause);
      phase = DeviceLinkPhase.failed;
      pairingCode = null;
    }
    if (!_disposed && revision == _revision) notifyListeners();
  }

  Future<void> reconnect() async {
    final invitation = _invitation;
    if (invitation != null) await connect(invitation);
  }

  Future<void> send(String text) async {
    if (_disposed ||
        sending ||
        phase != DeviceLinkPhase.connected ||
        text.trim().isEmpty) {
      return;
    }
    final revision = _revision;
    sending = true;
    error = null;
    notifyListeners();
    final elapsed = createStopwatch()..start();
    try {
      final echoed = await _repository.echo(text);
      if (_disposed || revision != _revision) return;
      messages.addAll([
        (text: text, fromPeer: false),
        (text: echoed, fromPeer: true),
      ]);
      if (messages.length > 40) messages.removeRange(0, messages.length - 40);
      lastRoundTrip = elapsed.elapsed;
    } catch (cause) {
      if (!_disposed && revision == _revision) error = _describe(cause);
    } finally {
      if (!_disposed && revision == _revision) {
        sending = false;
        notifyListeners();
      }
    }
  }

  Future<void> disconnect() async {
    _resumeConnection = false;
    await _dropConnection();
  }

  Future<void> _dropConnection() async {
    _revision++;
    phase = DeviceLinkPhase.disconnected;
    pairingCode = null;
    sending = false;
    error = null;
    notifyListeners();
    await _repository.disconnect();
  }

  Future<void> forgetPairings() async {
    await disconnect();
    try {
      await _repository.forgetPeers();
    } catch (cause) {
      if (!_disposed) {
        error = _describe(cause);
        notifyListeners();
      }
    }
  }

  Future<void> suspend() async {
    if (_suspended) return;
    _suspended = true;
    _resumeConnection = phase == DeviceLinkPhase.connected;
    await _dropConnection();
  }

  Future<void> resume() async {
    _suspended = false;
    if (!_resumeConnection || _disposed) return;
    _resumeConnection = false;
    await reconnect();
  }

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    unawaited(_subscription?.cancel());
    unawaited(_repository.dispose());
    super.dispose();
  }
}
