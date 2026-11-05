import '../protocol.dart';

/// The desktop protocol's tunneled IPC boundary. No Portal commands or models.
abstract interface class DesktopIpc {
  Stream<Map<String, dynamic>> get events;

  /// [timeout] defaults to the session's request timeout.
  Future<Object?> invoke(
    String channel, [
    List<Object?> args = const [],
    Duration? timeout,
  ]);
}

final class DesktopIpcRefusal extends DeviceLinkException {
  const DesktopIpcRefusal(super.message, {this.code});
  final String? code;
}

/// Local admission rejected a request before any bytes were sent.
final class DesktopIpcNotSent extends DeviceLinkException {
  const DesktopIpcNotSent(super.message);
}
