import 'items.dart';

enum BackgroundTrayIndicator {
  spinner,
  needsInput,
  failed,
  cancelled,
  finished,
  succeeded,
}

enum BackgroundTrayGroupKind {
  needsYou('Needs you'),
  running('Running'),
  finished('Finished');

  const BackgroundTrayGroupKind(this.label);
  final String label;
}

final class BackgroundTrayGroup {
  const BackgroundTrayGroup(this.kind, this.items);

  final BackgroundTrayGroupKind kind;
  final List<BackgroundTrayItem> items;
}

final class BackgroundTrayKindCount {
  const BackgroundTrayKindCount(this.kind, this.count, {this.cornerDot});

  final BackgroundTrayKind kind;
  final int count;
  final BackgroundTrayIndicator? cornerDot;
  bool get showsCount => count > 1;
}

final class BackgroundTraySummary {
  const BackgroundTraySummary({
    this.text = '',
    this.running = 0,
    this.indicator,
    this.groups = const [],
    this.kinds = const [],
  });

  final String text;
  final int running;
  final BackgroundTrayIndicator? indicator;
  final List<BackgroundTrayGroup> groups;
  final List<BackgroundTrayKindCount> kinds;
  bool get isHidden => text.isEmpty;
  bool get showsGroupLabels => groups.length > 1;
}

BackgroundTraySummary summarizeBackgroundTray({
  Iterable<BackgroundTrayTask> tasks = const [],
  Iterable<BackgroundTrayAgent> agents = const [],
  Iterable<BackgroundTrayRun> runs = const [],
  int unlistedDelegations = 0,
}) {
  final listedAgents = agents.toList();
  final agentTaskIds = listedAgents.map((agent) => agent.taskId).toSet();
  final live = tasks
      .where((task) => task.isLive && !agentTaskIds.contains(task.id))
      .toList();
  final approval = listedAgents
      .where((agent) => agent.status == BackgroundTrayAgentStatus.approval)
      .toList();
  final runningAgents = listedAgents
      .where((agent) => agent.status != BackgroundTrayAgentStatus.approval)
      .toList();
  final listedRuns = runs.toList();
  List<BackgroundTrayRun> withStatus(BackgroundTrayRunStatus status) =>
      listedRuns.where((run) => run.status == status).toList();
  final needsInputRuns = withStatus(BackgroundTrayRunStatus.needsInput);
  final pausedRuns = withStatus(BackgroundTrayRunStatus.paused);
  final runningRuns = withStatus(BackgroundTrayRunStatus.running);
  final finishedRuns = listedRuns
      .where((run) => run.status.isFinished)
      .toList();
  final unlisted = unlistedDelegations < 0 ? 0 : unlistedDelegations;
  final running =
      live.length + runningAgents.length + unlisted + runningRuns.length;
  final needsInput = approval.length + needsInputRuns.length;
  final text = [
    if (running > 0) '$running running in the background',
    if (needsInput > 0)
      '$needsInput ${needsInput == 1 ? 'needs' : 'need'} input',
    if (pausedRuns.isNotEmpty) '${pausedRuns.length} paused',
    if (finishedRuns.isNotEmpty) '${finishedRuns.length} finished',
  ].join(' · ');
  if (text.isEmpty) return const BackgroundTraySummary();

  final indicator = running > 0
      ? BackgroundTrayIndicator.spinner
      : needsInput > 0 || pausedRuns.isNotEmpty
      ? BackgroundTrayIndicator.needsInput
      : finishedRuns.any((run) => run.status == BackgroundTrayRunStatus.failed)
      ? BackgroundTrayIndicator.failed
      : finishedRuns.any(
          (run) => run.status == BackgroundTrayRunStatus.cancelled,
        )
      ? BackgroundTrayIndicator.cancelled
      : finishedRuns.any(
          (run) => run.status == BackgroundTrayRunStatus.completed,
        )
      ? BackgroundTrayIndicator.finished
      : BackgroundTrayIndicator.succeeded;

  final delegates = listedAgents
      .where((agent) => agent.kind == BackgroundTrayAgentKind.delegate)
      .length;
  final groupRows = <BackgroundTrayGroupKind, List<BackgroundTrayItem>>{
    BackgroundTrayGroupKind.needsYou: [
      ...approval,
      ...needsInputRuns,
      ...pausedRuns,
    ],
    BackgroundTrayGroupKind.running: [
      ...runningAgents,
      if (unlisted > 0)
        BackgroundTrayUnlistedDelegates(unlisted, listed: delegates),
      ...live,
      ...runningRuns,
    ],
    BackgroundTrayGroupKind.finished: finishedRuns,
  };
  return BackgroundTraySummary(
    text: text,
    running: running,
    indicator: indicator,
    groups: List.unmodifiable([
      for (final entry in groupRows.entries)
        if (entry.value.isNotEmpty)
          BackgroundTrayGroup(entry.key, List.unmodifiable(entry.value)),
    ]),
    kinds: _collapsedKinds(live, listedAgents, listedRuns, unlisted),
  );
}

List<BackgroundTrayKindCount> _collapsedKinds(
  List<BackgroundTrayTask> tasks,
  List<BackgroundTrayAgent> agents,
  List<BackgroundTrayRun> runs,
  int unlisted,
) {
  final kinds = <BackgroundTrayKindCount>[];
  for (final kind in [
    BackgroundTrayKind.agent,
    BackgroundTrayKind.bash,
    BackgroundTrayKind.workflow,
    BackgroundTrayKind.task,
  ]) {
    final count =
        tasks.where((task) => task.kind == kind).length +
        (kind == BackgroundTrayKind.agent ? agents.length + unlisted : 0);
    if (count > 0) kinds.add(BackgroundTrayKindCount(kind, count));
  }
  for (final kind in BackgroundTrayRunKind.values) {
    final ofKind = runs.where((run) => run.kind == kind).toList();
    if (ofKind.isEmpty) continue;
    final dot =
        ofKind.any(
          (run) =>
              run.status == BackgroundTrayRunStatus.needsInput ||
              run.status == BackgroundTrayRunStatus.paused,
        )
        ? BackgroundTrayIndicator.needsInput
        : ofKind.any((run) => run.status == BackgroundTrayRunStatus.failed)
        ? BackgroundTrayIndicator.failed
        : null;
    kinds.add(
      BackgroundTrayKindCount(
        switch (kind) {
          BackgroundTrayRunKind.pipeline => BackgroundTrayKind.pipeline,
          BackgroundTrayRunKind.github => BackgroundTrayKind.github,
          BackgroundTrayRunKind.githubPr => BackgroundTrayKind.githubPr,
        },
        ofKind.length,
        cornerDot: dot,
      ),
    );
  }
  return List.unmodifiable(kinds);
}
