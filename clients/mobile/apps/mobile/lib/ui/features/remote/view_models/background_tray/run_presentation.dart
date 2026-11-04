import 'dart:math' as math;

import '../pipeline_run_status.dart';
import 'items.dart';

/// A run row's one action. The accessible name never repeats the run's name,
/// matching the desktop's `runActionAriaLabel`.
enum BackgroundTrayRunAction {
  stop('Stop', 'Stop run'),
  respond('Respond', 'Respond to run'),
  resume('Resume', 'Resume run'),
  dismiss('Dismiss', 'Dismiss run');

  const BackgroundTrayRunAction(this.label, this.semanticsLabel);

  final String label;
  final String semanticsLabel;
}

/// [canStop] is the host's command gate. Respond and Resume always show for
/// a waiting pipeline run: without a resume command the host opens the run.
BackgroundTrayRunAction? backgroundTrayRunAction(
  BackgroundTrayRun run, {
  required bool canStop,
}) {
  final pipeline = run.kind == BackgroundTrayRunKind.pipeline;
  return switch (run.status) {
    BackgroundTrayRunStatus.running =>
      pipeline && canStop ? BackgroundTrayRunAction.stop : null,
    BackgroundTrayRunStatus.needsInput =>
      pipeline ? BackgroundTrayRunAction.respond : null,
    BackgroundTrayRunStatus.paused =>
      pipeline ? BackgroundTrayRunAction.resume : null,
    _ => BackgroundTrayRunAction.dismiss,
  };
}

String backgroundTrayRunStatusLabel(BackgroundTrayRunStatus status) =>
    switch (status) {
      BackgroundTrayRunStatus.running => 'Running',
      BackgroundTrayRunStatus.needsInput => 'Needs input',
      BackgroundTrayRunStatus.paused => 'Paused',
      BackgroundTrayRunStatus.succeeded => 'Succeeded',
      BackgroundTrayRunStatus.failed => 'Failed',
      BackgroundTrayRunStatus.cancelled => 'Cancelled',
      BackgroundTrayRunStatus.completed => 'Completed',
    };

/// The elapsed time while running; otherwise where the run stands.
String backgroundTrayRunTrailing(BackgroundTrayRun run, int now) {
  final start = run.startedAt;
  if (run.status == BackgroundTrayRunStatus.running && start != null) {
    return _formatElapsed(math.max(0, now - start));
  }
  return run.statusLabel ?? backgroundTrayRunStatusLabel(run.status);
}

/// The run's running jobs in run order, or null when none is running.
String? backgroundTrayRunRunningJobs(BackgroundTrayRun run) {
  final names = [
    for (final job in run.pipelineRun?.jobs ?? const [])
      if (switch (normalizePipelineRunStatus(job.status)) {
        'running' || 'restarting' => true,
        _ => false,
      })
        job.name,
  ];
  return names.isEmpty ? null : names.join(', ');
}

/// Full units for run rows; omit zero units except for a just-started run.
String _formatElapsed(int milliseconds) {
  final seconds = milliseconds ~/ 1000;
  final units = [
    (seconds ~/ 3600, 'hour'),
    ((seconds % 3600) ~/ 60, 'minute'),
    (seconds % 60, 'second'),
  ];
  final parts = [
    for (final (value, unit) in units)
      if (value > 0) '$value $unit${value == 1 ? '' : 's'}',
  ];
  return parts.isEmpty ? '0 seconds' : parts.join(', ');
}
