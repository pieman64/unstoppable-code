/// Display vocabulary for the desktop composer's grouped work drawer.
enum WorkGroup {
  needsYou('Needs you'),
  queued('Queued'),
  running('Running'),
  pullRequests('Pull requests'),
  watching('Watching');

  const WorkGroup(this.label);
  final String label;
}

enum WorkKind {
  agent,
  command,
  workflow,
  task,
  pipeline,
  github,
  pullRequest,
  watcher,
  message,
}

enum WorkTone { neutral, running, attention, success, failed, merged, info }

enum WorkAction {
  stopTask,
  stopDelegate,
  stopDelegates,
  deleteWatcher,
  cancelQueued,
  forceQueued,
  steerQueued,
}

final class WorkItem {
  const WorkItem({
    required this.id,
    required this.group,
    required this.kind,
    required this.title,
    this.subtitle,
    this.status,
    this.tone = WorkTone.neutral,
    this.details = const {},
    this.action,
    this.actionId,
    this.url,
    this.pipelineId,
    this.watcherCount = 0,
    this.count = 1,
    this.finished = false,
    this.extraActions = const [],
    this.actionLabels = const {},
  });

  final String id, title;
  final WorkGroup group;
  final WorkKind kind;
  final String? subtitle, status;
  final WorkTone tone;
  final Map<String, String> details;
  final WorkAction? action;
  final String? actionId, url, pipelineId;
  final int watcherCount, count;
  final bool finished;
  final List<WorkAction> extraActions;
  final Map<WorkAction, String> actionLabels;

  WorkItem withWatcherCount(int value) => WorkItem(
    id: id,
    group: group,
    kind: kind,
    title: title,
    subtitle: subtitle,
    status: status,
    tone: tone,
    details: details,
    action: action,
    actionId: actionId,
    url: url,
    pipelineId: pipelineId,
    watcherCount: value,
    count: count,
    finished: finished,
    extraActions: extraActions,
    actionLabels: actionLabels,
  );
}

final class WorkDrawerState {
  const WorkDrawerState({
    this.items = const [],
    this.errors = const [],
    this.loading = false,
  });
  final List<WorkItem> items;
  final List<String> errors;
  final bool loading;
  int count(WorkGroup group) => items
      .where((i) => i.group == group && !i.finished)
      .fold(0, (n, i) => n + i.count);
  bool get visible =>
      loading || errors.isNotEmpty || items.any((i) => !i.finished);
  String get summary => [
    for (final group in [
      WorkGroup.queued,
      WorkGroup.running,
      WorkGroup.pullRequests,
      WorkGroup.watching,
      WorkGroup.needsYou,
    ])
      if (count(group) > 0) '${group.label} ${count(group)}',
  ].join(' | ');
}
