import 'dart:async';

import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';

import '../remote_identity.dart';
import 'clock.dart';
import 'items.dart';
import 'mapper.dart';
import 'run_lifetime.dart';
import 'summary.dart';

/// Pure Dart coordinator for one remote chat's tray (CAN-5254).
///
/// The shell feeds snapshots from RemoteControlViewModel, supplies expansion
/// state, and disposes this model when leaving. Keep the supplied lifetime
/// for the connection/session so seen-live and dismissed runs survive tab
/// switches. Nothing is persisted, and no transport or widgets are imported.
final class BackgroundTrayViewModel {
  BackgroundTrayViewModel({
    required this.onChanged,
    BackgroundTrayRunLifetime? lifetime,
    int Function()? nowMs,
    Timer Function(Duration, void Function(Timer)) periodicTimer =
        Timer.periodic,
  }) : _lifetime = lifetime ?? BackgroundTrayRunLifetime() {
    _clock = BackgroundTrayClock(
      onTick: onChanged,
      nowMs: nowMs,
      periodicTimer: periodicTimer,
    );
  }

  final void Function() onChanged;
  final BackgroundTrayRunLifetime _lifetime;
  late final BackgroundTrayClock _clock;
  RemoteChatKey? _chat;
  List<BackgroundTrayTask> _tasks = const [];
  List<BackgroundTrayAgent> _agents = const [];
  List<BackgroundTrayRun> _runs = const [];
  int _unlisted = 0;
  bool _expanded = false;
  bool _disposed = false;
  BackgroundTraySummary _summary = const BackgroundTraySummary();

  BackgroundTraySummary get summary => _summary;
  bool get expanded => _expanded;
  int get now => _clock.now;

  /// Rows must come from the active paired session. Scope them here as well
  /// as at the source so another chat/worktree cannot populate this tray.
  void update({
    required RemoteChatTarget target,
    Iterable<RemoteBackgroundProcess> backgroundProcesses = const [],
    Iterable<RemoteChatMessage> messages = const [],
    Iterable<RemotePipelineRun> pipelineRuns = const [],
    RemoteChatSummary? chatSummary,
  }) {
    if (_disposed) return;
    final chat = remoteChatKeyForTarget(target);
    if (chat != _chat) {
      _expanded = false;
      _clock.setExpanded(false);
    }
    _chat = chat;
    final transcript = messages
        .where(
          (message) =>
              message.chatId == chat?.chatId &&
              (message.scope == null || message.scope == target.scope),
        )
        .toList();
    _tasks = [
      if (target is RemoteWorktreeChatTarget && chat != null)
        for (final process in backgroundProcesses)
          if (process.chatId == chat.chatId &&
              process.workspaceLocalId == target.workspaceLocalId &&
              process.worktreeLocalId == target.worktreeLocalId)
            BackgroundTrayTask(process),
    ];
    _agents = mapBackgroundTrayAgents(transcript, _tasks);
    final delegates = _agents
        .where((agent) => agent.kind == BackgroundTrayAgentKind.delegate)
        .length;
    final reported =
        chatSummary?.chatId == chat?.chatId &&
            (chatSummary?.scope == null || chatSummary?.scope == target.scope)
        ? chatSummary?.backgroundDelegations ?? 0
        : 0;
    _unlisted = reported > delegates ? reported - delegates : 0;
    _runs = target is RemoteWorktreeChatTarget
        ? mapBackgroundTrayPipelineRuns(
            target: target,
            messages: transcript,
            pipelineRuns: pipelineRuns,
          )
        : const [];
    _rebuild();
    onChanged();
  }

  void setExpanded(bool expanded) {
    if (_disposed || _summary.isHidden || _expanded == expanded) return;
    _expanded = expanded;
    // Opening refreshes now and notifies through the clock immediately.
    _clock.setExpanded(expanded);
    if (!expanded) onChanged();
  }

  void dismissRun(String runId) {
    final chat = _chat;
    if (_disposed ||
        chat == null ||
        !_runs.any((run) => run.id == runId && run.status.isFinished)) {
      return;
    }
    _lifetime.dismiss(chat, runId);
    _rebuild();
    onChanged();
  }

  void _rebuild() {
    final chat = _chat;
    _summary = summarizeBackgroundTray(
      tasks: _tasks,
      agents: _agents,
      runs: chat == null ? const [] : _lifetime.select(chat, _runs),
      unlistedDelegations: _unlisted,
    );
    if (_summary.isHidden) {
      _expanded = false;
      _clock.setExpanded(false);
    }
  }

  void dispose() {
    _disposed = true;
    _clock.dispose();
  }
}
