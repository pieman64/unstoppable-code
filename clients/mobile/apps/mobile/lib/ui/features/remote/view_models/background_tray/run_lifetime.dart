import '../remote_identity.dart';
import 'items.dart';

/// Session memory, owned by the host and retained across chat switches.
final class BackgroundTrayRunLifetime {
  final Map<RemoteChatKey, Set<String>> _seenLive = {};
  final Map<RemoteChatKey, Set<String>> _dismissed = {};

  List<BackgroundTrayRun> select(
    RemoteChatKey chat,
    Iterable<BackgroundTrayRun> runs,
  ) {
    final seen = _seenLive.putIfAbsent(chat, () => {});
    final dismissed = _dismissed.putIfAbsent(chat, () => {});
    return List.unmodifiable([
      for (final run in runs)
        if (!run.status.isFinished)
          _markLive(run, seen, dismissed)
        else if (seen.contains(run.id) && !dismissed.contains(run.id))
          run,
    ]);
  }

  BackgroundTrayRun _markLive(
    BackgroundTrayRun run,
    Set<String> seen,
    Set<String> dismissed,
  ) {
    seen.add(run.id);
    dismissed.remove(run.id);
    return run;
  }

  void dismiss(RemoteChatKey chat, String runId) =>
      (_dismissed[chat] ??= {}).add(runId);
}
