import 'dart:async';
import 'dart:typed_data';

/// The byte stream for one peer. Closing it never closes another peer's stream.
abstract interface class DesktopRelayTransport {
  Stream<Uint8List> get frames;
  Stream<void> get closed;

  /// Why the transport ended, once it has.
  String? get closeReason;
  void send(Uint8List payload);
}

final class DesktopRelayChannel implements DesktopRelayTransport {
  DesktopRelayChannel({required this.sendFrame, required this.onClose});
  final void Function(Uint8List) sendFrame;
  final void Function() onClose;
  final _frames = StreamController<Uint8List>.broadcast();
  final _closed = StreamController<void>.broadcast();
  bool _ended = false;
  @override
  String? closeReason;
  @override
  Stream<Uint8List> get frames => _frames.stream;
  @override
  Stream<void> get closed => _closed.stream;
  void receive(Uint8List payload) {
    if (!_ended) _frames.add(payload);
  }

  @override
  void send(Uint8List payload) {
    if (_ended) throw StateError('The computer connection ended.');
    sendFrame(payload);
  }

  Future<void> close([String reason = 'Closed by this device.']) async {
    if (_ended) return;
    _ended = true;
    closeReason = reason;
    onClose();
    _closed.add(null);
    unawaited(_closed.close());
    unawaited(_frames.close());
  }
}
