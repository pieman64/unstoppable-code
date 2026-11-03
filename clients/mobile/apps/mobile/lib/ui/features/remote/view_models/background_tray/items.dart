import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';

/// The shared desktop/Portal drawer vocabulary. GitHub data is wired by the
/// protocol follow-up; its kinds already participate in summary and ordering.
enum BackgroundTrayKind {
  agent,
  bash,
  workflow,
  task,
  pipeline,
  github,
  githubPr,
}

enum BackgroundTrayAgentKind { claude, codex, delegate }

enum BackgroundTrayAgentStatus { queued, running, approval }

enum BackgroundTrayRunStatus {
  running,
  needsInput,
  paused,
  succeeded,
  failed,
  cancelled,
  completed;

  bool get isFinished => switch (this) {
    running || needsInput || paused => false,
    _ => true,
  };
}

sealed class BackgroundTrayItem {
  const BackgroundTrayItem();

  String get id;
  String get title;
}

final class BackgroundTrayTask extends BackgroundTrayItem {
  const BackgroundTrayTask(this.process);

  final RemoteBackgroundProcess process;

  @override
  String get id => process.localId;
  @override
  String get title => process.description;

  BackgroundTrayKind get kind => switch (process.kind) {
    RemoteBackgroundProcessKind.agent => BackgroundTrayKind.agent,
    RemoteBackgroundProcessKind.bash => BackgroundTrayKind.bash,
    RemoteBackgroundProcessKind.workflow => BackgroundTrayKind.workflow,
    _ => BackgroundTrayKind.task,
  };

  bool get isLive => switch (process.status) {
    RemoteBackgroundProcessStatus.completed ||
    RemoteBackgroundProcessStatus.failed ||
    RemoteBackgroundProcessStatus.stopped => false,
    _ => true,
  };

  int? get settledAt => isLive ? null : process.updatedAt;
}

final class BackgroundTrayAgentStep {
  const BackgroundTrayAgentStep({
    required this.id,
    required this.toolName,
    required this.input,
    this.toolFamily,
  });

  final String id;
  final String toolName;
  final String input;
  final String? toolFamily;
}

enum BackgroundTrayAgentTargetKind { managed, claudeNative }

final class BackgroundTrayAgentTarget {
  const BackgroundTrayAgentTarget({required this.kind, required this.id});

  final BackgroundTrayAgentTargetKind kind;
  final String id;
}

final class BackgroundTrayAgent extends BackgroundTrayItem {
  const BackgroundTrayAgent({
    required this.id,
    required this.title,
    required this.kind,
    required this.status,
    this.activity,
    this.startedAt,
    this.steps = const [],
    this.prompt,
    this.meta,
    this.taskId,
    this.target,
  });

  @override
  final String id;
  @override
  final String title;
  final BackgroundTrayAgentKind kind;
  final BackgroundTrayAgentStatus status;
  final String? activity;
  final int? startedAt;
  final List<BackgroundTrayAgentStep> steps;
  final String? prompt;
  final String? meta;

  /// The process row id, not the provider's task id. It removes that task
  /// from the tray so a Claude agent appears once.
  final String? taskId;
  final BackgroundTrayAgentTarget? target;
}

final class BackgroundTrayUnlistedDelegates extends BackgroundTrayItem {
  const BackgroundTrayUnlistedDelegates(this.count, {required this.listed});

  final int count;
  final int listed;

  @override
  String get id => 'unlisted-delegates';
  @override
  String get title =>
      '$count ${listed > 0 ? 'more ' : ''}${count == 1 ? 'delegate' : 'delegates'}';
}

enum BackgroundTrayRunKind { pipeline, github, githubPr }

final class BackgroundTrayRun extends BackgroundTrayItem {
  const BackgroundTrayRun({
    required this.id,
    required this.title,
    required this.kind,
    required this.status,
    this.startedAt,
    this.question,
    this.repository,
    this.statusLabel,
    this.note,
    this.pipelineRun,
  });

  @override
  final String id;
  @override
  final String title;
  final BackgroundTrayRunKind kind;
  final BackgroundTrayRunStatus status;
  final int? startedAt;
  final String? question;
  final String? repository;
  final String? statusLabel;
  final String? note;

  /// Keeps execution identity, job details and timing available to the run
  /// inspector without another projection or transport call.
  final RemotePipelineRun? pipelineRun;
}
