/// Dart port of the desktop clean chat look's step runs
/// (`packages/ui-shared/src/components/chat/clean-step-runs.ts` and
/// `step-words.tsx`): every run of agent steps between two replies reads as
/// one line in words ("Ran 2 commands, read a file") instead of a row per
/// step. Pure: the transcript projection segments, widgets render.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';

/// The kinds of agent step a run's words count (desktop `StepKind`).
enum StepKind {
  thinking,
  search,
  read,
  edit,
  plan,
  command,
  graph,
  web,
  tasks,
  agent,
  question,
  other,
}

/// Newest steps a running turn keeps in view under its run's line (desktop
/// `RECENT_STEP_COUNT`, the default "Recent" chat detail).
const int recentStepCount = 3;

/// One step of a run: the part at [index] of [message].
final class RunStep {
  const RunStep(this.message, this.index);

  final ChatMessage message;
  final int index;

  ChatPart get part => message.parts[index];

  @override
  bool operator ==(Object other) =>
      other is RunStep &&
      identical(other.message, message) &&
      other.index == index;

  @override
  int get hashCode => Object.hash(identityHashCode(message), index);
}

/// What a turn draws, in order: a message (its reply text, and its steps
/// when [parts]), or a run of steps.
sealed class TurnSegment {
  const TurnSegment();
}

final class MessageSegment extends TurnSegment {
  const MessageSegment(this.message, {this.parts = true});

  final ChatMessage message;

  /// False when the message's steps joined the run before it.
  final bool parts;
}

final class RunSegment extends TurnSegment {
  const RunSegment(this.key, this.steps, {this.anchorMessageId});

  /// Stable while the run grows: from its first step's message.
  final String key;
  final List<RunStep> steps;

  /// The first message whose only row is this run, so the feed can hold the
  /// reader on it while older history loads. Null when every message also
  /// draws its words in a reply row, which anchors it instead.
  final String? anchorMessageId;
}

/// Tools that end a run: the person reads or answers them where they are.
const _breakTools = {'AskUserQuestion', 'ExitPlanMode'};

bool _isStep(ChatPart part) => switch (part.kind) {
  'tool_use' => !_breakTools.contains(part.toolName),
  'thinking' => (part.thinkingText ?? '').trim().isNotEmpty,
  'agent' => true,
  _ => false,
};

bool _isBreak(ChatPart part) =>
    part.kind == 'tool_use' && _breakTools.contains(part.toolName);

/// Whether a message has something besides its steps to draw: words,
/// files, a delivery state or a failure.
bool _hasBody(ChatMessage message) =>
    message.text.trim().isNotEmpty ||
    message.attachments.isNotEmpty ||
    message.delivery != null ||
    message.status == ChatMessageStatus.failed ||
    message.status == ChatMessageStatus.cancelled;

/// Splits a turn's assistant [messages] into replies and runs of steps
/// (desktop `groupCleanSteps`). A message carrying steps and words gives its
/// steps to the run and its words to the reply after it. [renderable]
/// decides whether a message without steps draws at all.
List<TurnSegment> segmentTurn(
  List<ChatMessage> messages, {
  required bool Function(ChatMessage message) renderable,
}) {
  final segments = <TurnSegment>[];
  var run = <RunStep>[];
  String? anchor;
  void flush() {
    if (run.isNotEmpty) {
      segments.add(
        RunSegment(
          'run-${run.first.message.messageId}',
          run,
          anchorMessageId: anchor,
        ),
      );
      run = <RunStep>[];
      anchor = null;
    }
  }

  for (final message in messages) {
    final parts = message.parts;
    if (parts.any(_isBreak)) {
      flush();
      segments.add(MessageSegment(message));
      continue;
    }
    final steps = [
      for (var index = 0; index < parts.length; index++)
        if (_isStep(parts[index])) RunStep(message, index),
    ];
    if (steps.isEmpty) {
      if (!renderable(message)) continue;
      flush();
      segments.add(MessageSegment(message));
      continue;
    }
    run.addAll(steps);
    if (!_hasBody(message)) anchor ??= message.messageId;
    if (_hasBody(message)) {
      flush();
      segments.add(MessageSegment(message, parts: false));
    }
  }
  flush();
  return segments;
}

/// The kind of step one part counts as (desktop `stepKindOfToolCall`).
StepKind stepKindOf(ChatPart part) {
  if (part.kind == 'thinking') return StepKind.thinking;
  if (part.kind == 'agent') return StepKind.agent;
  return switch (part.toolFamily) {
    'grep' || 'glob' => StepKind.search,
    'read' => StepKind.read,
    'edit' || 'write' => StepKind.edit,
    'plan' => StepKind.plan,
    'bash' || 'script-output' => StepKind.command,
    'graph' => StepKind.graph,
    'web' => StepKind.web,
    'todo' => StepKind.tasks,
    'agent' => StepKind.agent,
    'ask-user' => StepKind.question,
    _ => StepKind.other,
  };
}

/// Steps the run's line stands for. A line never stands for fewer than two
/// calls; thinking does not count toward that.
int countedSteps(Iterable<RunStep> steps) =>
    steps.where((step) => step.part.kind != 'thinking').length;

/// The result a step's call settled with, or null while it runs.
ToolCallResult? stepResult(RunStep step, Map<String, ToolCallResult> results) {
  final part = step.part;
  final id = part.toolUseId;
  return (id == null ? null : results[id]) ?? embeddedToolResult(part);
}

bool _stepFailed(RunStep step, Map<String, ToolCallResult> results) {
  final part = step.part;
  if (part.kind == 'agent') return part.data?['isError'] == true;
  if (part.kind != 'tool_use') return false;
  return stepResult(step, results)?.isError ?? false;
}

String _plural(int count, String one, String many) =>
    '$count ${count == 1 ? one : many}';

String _times(int count) => count == 1 ? '' : ' $count times';

String _phrase(StepKind kind, int count) => switch (kind) {
  StepKind.thinking => 'thought',
  StepKind.search => 'searched ${count == 1 ? 'once' : '$count times'}',
  StepKind.read => 'read ${_plural(count, 'file', 'files')}',
  StepKind.edit => 'edited ${_plural(count, 'file', 'files')}',
  StepKind.plan => 'wrote plan${_times(count)}',
  StepKind.command => 'ran ${_plural(count, 'command', 'commands')}',
  StepKind.graph => 'checked the code graph',
  StepKind.web => 'searched the web',
  StepKind.tasks => 'updated the task list',
  StepKind.agent => 'ran ${_plural(count, 'agent', 'agents')}',
  StepKind.question =>
    'asked ${count == 1 ? 'a question' : '$count questions'}',
  StepKind.other => 'used ${_plural(count, 'tool', 'tools')}',
};

/// A run's line (desktop `describeCleanRun`): what it did, counted, kinds
/// in the order they first appear ("Ran 4 commands, read 2 files"), how many
/// steps failed, and the kind the words lead with. Thinking only shows when
/// the run did nothing else ("Thought"). A plan write never reads as done
/// before its result says so.
({String label, int failed, StepKind? kind}) describeRun(
  List<RunStep> steps,
  Map<String, ToolCallResult> results,
) {
  final counts = <String, int>{};
  final kinds = <String, StepKind>{};
  var failed = 0;
  for (final step in steps) {
    final kind = stepKindOf(step.part);
    final stepFailed = _stepFailed(step, results);
    if (stepFailed) failed += 1;
    final key = kind != StepKind.plan
        ? kind.name
        : stepFailed
        ? 'plan-failed'
        : step.part.kind == 'tool_use' && stepResult(step, results) == null
        ? 'plan-pending'
        : kind.name;
    counts[key] = (counts[key] ?? 0) + 1;
    kinds[key] = kind;
  }
  if (counts.length > 1) counts.remove(StepKind.thinking.name);
  final sentence = [
    for (final MapEntry(:key, value: count) in counts.entries)
      switch (key) {
        'plan-failed' => "couldn't write plan${_times(count)}",
        'plan-pending' => 'writing plan${_times(count)}',
        _ => _phrase(kinds[key]!, count),
      },
  ].join(', ');
  return (
    label: sentence.isEmpty
        ? sentence
        : '${sentence[0].toUpperCase()}${sentence.substring(1)}',
    failed: failed,
    kind: counts.isEmpty ? null : kinds[counts.keys.first],
  );
}
