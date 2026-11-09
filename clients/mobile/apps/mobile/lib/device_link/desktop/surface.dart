import 'ipc.dart';

/// Independent IPC sender and subscriptions on an existing paired session.
abstract interface class DesktopOrchestratorConnection {
  DesktopIpc get orchestrator;
  Future<void> setOrchestratorVisible(bool visible);
}

final class DesktopSurfaceIpc implements DesktopIpc {
  DesktopSurfaceIpc({required this.events, required this.call});
  @override
  final Stream<Map<String, dynamic>> events;
  final Future<Object?> Function(String, List<Object?>, Duration?) call;
  @override
  Future<Object?> invoke(
    String channel, [
    List<Object?> args = const [],
    Duration? timeout,
  ]) => call(channel, args, timeout);
}
