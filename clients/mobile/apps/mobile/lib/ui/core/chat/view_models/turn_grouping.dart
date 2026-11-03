/// Pure turn-grouping for the mobile chat transcript. Dart port of
/// the web run viewer's `turn-grouping.ts`, which mirrors the desktop
/// `TurnGroupRenderer` pipeline:
///
///  * a `user` message opens a turn; every following non-user message belongs
///    to it until the next user message;
///  * within a turn, the LAST assistant message with visible text is the
///    final answer (always shown inline); everything else is intermediate
///    (collapsed behind a steps summary row);
///  * a turn that never produced a text answer (e.g. interrupted) keeps all
///    messages as intermediate with no final block;
///  * intermediates holding nothing but turn-timers/empties are not worth a
///    collapse row at all.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';

/// One conversational turn: the user prompt, the collapsed intermediate
/// steps, and the final assistant answer(s).
class ChatTurn {
  const ChatTurn({
    this.user,
    this.intermediate = const [],
    this.finalMessages = const [],
    this.assistantMessages = const [],
  });

  /// The user message that opened the turn; absent for a leading pre-user run.
  final ChatMessage? user;

  /// Intermediate messages, hidden behind the collapsed steps row.
  final List<ChatMessage> intermediate;

  /// The final assistant answer message(s), always shown inline.
  final List<ChatMessage> finalMessages;

  /// Every non-user message in its original transcript order. Live turns use
  /// this sequence because the final/intermediate partition is only a
  /// completed-turn presentation concern and can otherwise reorder messages.
  final List<ChatMessage> assistantMessages;

  /// Stable identity for expand/collapse state across rebuilds.
  String get key {
    final anchor =
        user ?? _firstOrNull(intermediate) ?? _firstOrNull(finalMessages);
    return anchor?.messageId ?? '';
  }

  /// A completed timer settles the turn even when a tool row still streams.
  bool get isStreaming =>
      isChatTurnRunning([?user, ...intermediate, ...finalMessages]);

  /// Live turns render inline until the host's completion evidence arrives.
  bool get isLive => isStreaming;

  /// Whether [intermediate] holds anything worth a collapse row — at least
  /// one message with visible text or a non-timer part. A turn whose only
  /// "intermediate" is a turn timer (a trivial one-shot answer) skips the
  /// row entirely.
  bool get hasCollapsibleIntermediate => intermediate.any((message) {
    if (message.text.trim().isNotEmpty) return true;
    return message.parts.any((part) => part.kind != 'turn_timer');
  });
}

ChatMessage? _firstOrNull(List<ChatMessage> list) =>
    list.isEmpty ? null : list.first;

bool _hasVisibleText(ChatMessage message) => message.text.trim().isNotEmpty;

/// Groups a flat transcript into [ChatTurn]s (see library doc for the
/// rules). Works on the merged live transcript, so a turn whose answer is
/// still streaming renders that answer as its final message live.
List<ChatTurn> groupChatTurns(List<ChatMessage> messages) {
  final turns = <ChatTurn>[];
  ChatMessage? currentUser;
  List<ChatMessage>? currentAssistant;

  void flush() {
    final assistant = currentAssistant;
    if (assistant == null) return;
    var finalIndex = -1;
    for (var i = assistant.length - 1; i >= 0; i -= 1) {
      if (_hasVisibleText(assistant[i])) {
        finalIndex = i;
        break;
      }
    }
    final intermediate = finalIndex == -1
        ? assistant
        : [
            for (var i = 0; i < assistant.length; i += 1)
              if (i != finalIndex) assistant[i],
          ];
    turns.add(
      ChatTurn(
        user: currentUser,
        intermediate: List.unmodifiable(intermediate),
        finalMessages: finalIndex == -1
            ? const []
            : List.unmodifiable([assistant[finalIndex]]),
        assistantMessages: List.unmodifiable(assistant),
      ),
    );
    currentUser = null;
    currentAssistant = null;
  }

  for (final message in messages) {
    if (message.role == ChatRole.user) {
      flush();
      currentUser = message;
      currentAssistant = [];
    } else {
      currentAssistant ??= [];
      currentAssistant?.add(message);
    }
  }
  flush();
  return turns;
}

/// Whether a message renders any visible content on its own bubble. Used to
/// skip the little empty bubbles produced by tool-result/timer-only frames.
bool hasRenderableContent(ChatMessage message) {
  if (message.text.trim().isNotEmpty) return true;
  // A file sent with no words is still a message the user sent; its bubble
  // carries the filename chips.
  if (message.attachments.isNotEmpty) return true;
  // A watcher message shows its title even without a visible notice.
  if (message.role == ChatRole.user && message.watcherFired != null) {
    return true;
  }
  // Timer-only system rows surface through the transcript's working
  // indicator, never as bubbles — even while their turn is still streaming.
  if (message.parts.isNotEmpty &&
      message.parts.every((part) => part.kind == 'turn_timer')) {
    return false;
  }
  if (message.isStreaming) return true;
  if (message.status == ChatMessageStatus.failed ||
      message.status == ChatMessageStatus.cancelled) {
    return true;
  }
  return message.parts.any(
    (part) =>
        part.kind == 'tool_use' ||
        part.kind == 'thinking' ||
        part.kind == 'agent',
  );
}

/// Categories of the collapsed steps card, in the desktop chip order
/// (`CollapsedTurnSummary` in `TurnGroupRenderer.tsx`). Enum declaration
/// order IS the display order.
enum TurnStepCategory {
  messages('messages'),
  thinking('thinking'),
  bash('bash'),
  read('read'),
  readLines('read lines'),
  writeEdit('write/edit'),
  plan('plan'),
  search('search'),
  grep('grep'),
  web('web'),
  agent('agents'),
  workflow('workflows'),
  tasks('tasks'),
  taskStop('stop'),
  skills('skills'),
  monitor('monitor'),
  claude('claude'),
  scheduleWakeup('wakeups'),
  askUser('questions'),
  scriptOutput('script output'),
  watcher('watcher'),
  canopy('app'),
  graph('code graph'),
  appAdvisor('orchestrator'),
  pipelineEditor('pipeline'),
  computerUse('computer use'),
  mcp('mcp'),
  other('other');

  const TurnStepCategory(this.label);

  /// Accessibility/aria label fragment, matching the desktop chip labels.
  final String label;
}

/// One chip of the collapsed steps card.
typedef TurnStepCount = ({TurnStepCategory category, int count});

/// Buckets a tool call the way desktop's `getToolCategory` does. The wire's
/// canonical `toolFamily` is authoritative; the raw name only disambiguates
/// families that fold several desktop buckets together (`glob` → search,
/// `todo` → tasks) or fills in when the family is missing.
TurnStepCategory _toolCategory(ChatPart part) {
  final name = part.toolName ?? '';
  if (isComputerUseTool(part)) return TurnStepCategory.computerUse;
  switch (name) {
    case 'Workflow':
      return TurnStepCategory.workflow;
    case 'TaskStop':
      return TurnStepCategory.taskStop;
    case 'ScheduleWakeup':
      return TurnStepCategory.scheduleWakeup;
    case 'ReadLines':
      return TurnStepCategory.readLines;
    case 'request_user_input':
      return TurnStepCategory.askUser;
    case 'ListMcpResourcesTool':
      return TurnStepCategory.mcp;
  }
  switch (part.toolFamily) {
    case 'bash':
      return TurnStepCategory.bash;
    case 'read':
      return TurnStepCategory.read;
    case 'edit' || 'write':
      return TurnStepCategory.writeEdit;
    case 'plan':
      return TurnStepCategory.plan;
    case 'glob':
      return TurnStepCategory.search;
    case 'grep':
      return TurnStepCategory.grep;
    case 'web':
      return TurnStepCategory.web;
    case 'agent':
      return TurnStepCategory.agent;
    case 'todo':
      return TurnStepCategory.tasks;
    case 'skill':
      return TurnStepCategory.skills;
    case 'monitor':
      return TurnStepCategory.monitor;
    case 'claude':
      return TurnStepCategory.claude;
    case 'ask-user':
      return TurnStepCategory.askUser;
    case 'script-output':
      return TurnStepCategory.scriptOutput;
    case 'watcher':
      return TurnStepCategory.watcher;
    case 'canopy':
      return TurnStepCategory.canopy;
    case 'graph':
      return TurnStepCategory.graph;
    case 'app-advisor':
      return TurnStepCategory.appAdvisor;
    case 'pipeline-editor':
      return TurnStepCategory.pipelineEditor;
    case 'computer-use':
      return TurnStepCategory.computerUse;
  }
  return switch (name) {
    'Bash' || 'PowerShell' || 'command' => TurnStepCategory.bash,
    'Read' => TurnStepCategory.read,
    'Write' || 'Edit' || 'NotebookEdit' => TurnStepCategory.writeEdit,
    'Glob' || 'ToolSearch' => TurnStepCategory.search,
    'Grep' => TurnStepCategory.grep,
    'WebFetch' || 'WebSearch' || 'web_search' => TurnStepCategory.web,
    'Skill' => TurnStepCategory.skills,
    'Monitor' => TurnStepCategory.monitor,
    'TaskCreate' ||
    'TaskUpdate' ||
    'TaskList' ||
    'TaskGet' ||
    'TodoWrite' => TurnStepCategory.tasks,
    'Task' ||
    'Agent' ||
    'SendMessage' ||
    'TaskOutput' => TurnStepCategory.agent,
    'AskUserQuestion' => TurnStepCategory.askUser,
    _ when name.startsWith('mcp__') => TurnStepCategory.mcp,
    _ => TurnStepCategory.other,
  };
}

/// Aggregates a turn's intermediate steps into desktop-ordered category
/// counts for the collapsed steps card (`computeTurnSummary` port):
/// intermediate messages with visible text, thinking parts with text, and
/// every `tool_use` part bucketed by category. Zero-count categories are
/// omitted.
List<TurnStepCount> summarizeTurnSteps(List<ChatMessage> intermediate) {
  final counts = <TurnStepCategory, int>{};
  void bump(TurnStepCategory category) =>
      counts[category] = (counts[category] ?? 0) + 1;
  for (final message in intermediate) {
    if (_hasVisibleText(message)) bump(TurnStepCategory.messages);
    for (final part in message.parts) {
      switch (part.kind) {
        case 'thinking':
          if (part.thinkingText != null) bump(TurnStepCategory.thinking);
        case 'tool_use':
          bump(_toolCategory(part));
        case 'agent':
          bump(TurnStepCategory.agent);
      }
    }
  }
  return [
    for (final category in TurnStepCategory.values)
      if (counts[category] case final count?)
        (category: category, count: count),
  ];
}

/// `"2 thinking, 1 write/edit"` — the desktop chip's aria text.
String describeTurnStepCounts(List<TurnStepCount> counts) =>
    counts.map((e) => '${e.count} ${e.category.label}').join(', ');
