import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/ui/core/chat/view_models/incremental_turn_groups.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

/// One row of the turn-structured transcript.
sealed class TranscriptRow {
  const TranscriptRow();

  /// Stable identity across revisions, or null for a row without one.
  String? get key;
}

final class TranscriptMessageRow extends TranscriptRow {
  const TranscriptMessageRow(
    this.message, {
    this.toolResults = const {},
    this.streamingSpinner = true,
  });

  final ChatMessage message;

  /// The owning turn's `tool_result` parts keyed by `toolUseId`, so each
  /// tool-call row can show its outcome inline.
  final Map<String, ToolCallResult> toolResults;

  /// False when the turn's working row already shows progress, so a
  /// streaming message does not add a second spinner.
  final bool streamingSpinner;

  @override
  String get key => 'message-${message.messageId}';

  @override
  bool operator ==(Object other) =>
      other is TranscriptMessageRow &&
      identical(other.message, message) &&
      identical(other.toolResults, toolResults) &&
      other.streamingSpinner == streamingSpinner;

  @override
  int get hashCode => Object.hash(
    identityHashCode(message),
    identityHashCode(toolResults),
    streamingSpinner,
  );
}

/// A completed turn's collapsed steps summary.
final class TranscriptStepsRow extends TranscriptRow {
  const TranscriptStepsRow(this.turn, this.counts, {required this.expanded});

  final ChatTurn turn;
  final List<TurnStepCount> counts;
  final bool expanded;

  @override
  String? get key => turn.key.isEmpty ? null : 'turn-steps-row-${turn.key}';

  @override
  bool operator ==(Object other) =>
      other is TranscriptStepsRow &&
      identical(other.turn, turn) &&
      identical(other.counts, counts) &&
      other.expanded == expanded;

  @override
  int get hashCode =>
      Object.hash(identityHashCode(turn), identityHashCode(counts), expanded);
}

/// A turn's working or completed timer, or the bottom "Working..." bridge
/// when [turnKey] is null.
final class TranscriptTimerRow extends TranscriptRow {
  const TranscriptTimerRow(this.timer, {this.initialElapsedMs, this.turnKey});

  /// The turn's authoritative timer, or null when only a streaming flag (no
  /// timer part) says the turn is running — the row then shows a bare
  /// "Working...".
  final TurnTimer? timer;
  final int? initialElapsedMs;
  final String? turnKey;

  @override
  String? get key => switch (turnKey) {
    null => 'turn-timer-bridge',
    '' => null,
    final turnKey => 'turn-timer-$turnKey',
  };

  @override
  bool operator ==(Object other) =>
      other is TranscriptTimerRow &&
      identical(other.timer, timer) &&
      other.initialElapsedMs == initialElapsedMs &&
      other.turnKey == turnKey;

  @override
  int get hashCode =>
      Object.hash(identityHashCode(timer), initialElapsedMs, turnKey);
}

/// A host-supplied row closing one turn, after its footer (or, for a live
/// turn, under its working row).
final class TranscriptTurnFooterRow extends TranscriptRow {
  const TranscriptTurnFooterRow(this.turnKey);

  final String turnKey;

  @override
  String get key => 'turn-footer-$turnKey';

  @override
  bool operator ==(Object other) =>
      other is TranscriptTurnFooterRow && other.turnKey == turnKey;

  @override
  int get hashCode => turnKey.hashCode;
}

/// Projects a transcript into [TranscriptRow]s: prompt, then the
/// intermediate agent steps collapsed behind one summary row, then the
/// answer — the desktop/web turn treatment.
///
/// Holds one transcript's turns and what each derives from its rows, so a
/// revision re-derives only the turns [IncrementalTurnGroups] regrouped, and
/// an unchanged turn hands back the same row objects. Assembling the row list
/// still visits every row, by reference.
class TranscriptProjection {
  final IncrementalTurnGroups _groups = IncrementalTurnGroups();
  List<ChatTurn> _turns = const [];
  List<_TurnFacts> _facts = const [];

  /// Rows handed to turn grouping so far.
  int get groupedMessageCount => _groups.groupedMessageCount;

  /// Turns whose derived facts (timer, tool results, step counts) were
  /// computed so far.
  int projectedTurnCount = 0;

  /// [footerTurns] are the turn keys that get a [TranscriptTurnFooterRow].
  List<TranscriptRow> rows({
    required List<ChatMessage> messages,
    required bool turnInProgress,
    required int? turnElapsedMs,
    required Set<String> expandedTurns,
    Set<String> footerTurns = const {},
  }) {
    final turns = _groups.update(messages);
    if (!identical(turns, _turns)) {
      final previous = HashMap<ChatTurn, _TurnFacts>.identity();
      final byFirstRow = HashMap<ChatMessage, _TurnFacts>.identity();
      for (final facts in _facts) {
        previous[facts.turn] = facts;
        byFirstRow[_firstRow(facts.turn)] = facts;
      }
      _facts = [
        for (final turn in turns)
          previous[turn] ?? _project(turn, byFirstRow[_firstRow(turn)]),
      ];
      _turns = turns;
    }
    final rows = <TranscriptRow>[];
    TurnTimer? newestTimer;
    String? newestFooter;
    for (var index = 0; index < _facts.length; index += 1) {
      final facts = _facts[index];
      final isNewest = index == _facts.length - 1;
      if (isNewest) newestTimer = facts.timer;
      rows.addAll(
        facts.rows(
          isNewest: isNewest,
          turnInProgress: turnInProgress,
          turnElapsedMs: turnElapsedMs,
          expanded: expandedTurns.contains(facts.turn.key),
        ),
      );
      final key = facts.turn.key;
      if (key.isNotEmpty && footerTurns.contains(key)) {
        if (isNewest) {
          newestFooter = key;
        } else {
          rows.add(TranscriptTurnFooterRow(key));
        }
      }
    }
    // Without an authoritative timer part, retain the send/streaming bridge
    // as a bare bottom-of-transcript "Working..." row.
    if (turnInProgress &&
        (newestTimer == null || newestTimer.completedAt != null)) {
      rows.add(TranscriptTimerRow(null, initialElapsedMs: turnElapsedMs));
    }
    // The newest turn's footer follows that bridge, which belongs to it.
    if (newestFooter != null) rows.add(TranscriptTurnFooterRow(newestFooter));
    return rows;
  }

  /// Derives a regrouped turn. [replaced] is the turn it supersedes, if
  /// any, whose tool results are kept when unchanged so the turn's other
  /// rows stay equal while its live answer streams.
  _TurnFacts _project(ChatTurn turn, _TurnFacts? replaced) {
    projectedTurnCount += 1;
    final toolResults = _turnToolResults(turn);
    final previous = replaced?.toolResults;
    return _TurnFacts(
      turn,
      previous != null && mapEquals(previous, toolResults)
          ? previous
          : toolResults,
    );
  }

  static ChatMessage _firstRow(ChatTurn turn) =>
      turn.user ?? turn.assistantMessages.first;
}

/// What a turn's rows derive from its messages alone, and the rows it last
/// produced.
final class _TurnFacts {
  _TurnFacts(this.turn, this.toolResults)
    : timer = findNewestTurnTimer([
        ...turn.intermediate,
        ...turn.finalMessages,
      ]),
      isLive = turn.isLive;

  final ChatTurn turn;
  final TurnTimer? timer;
  final bool isLive;
  final Map<String, ToolCallResult> toolResults;
  late final List<TurnStepCount> stepCounts = turn.hasCollapsibleIntermediate
      ? summarizeTurnSteps(turn.intermediate)
      : const [];

  ({bool isNewest, bool turnInProgress, int? turnElapsedMs, bool expanded})?
  _inputs;
  List<TranscriptRow> _rows = const [];

  /// The turn's rows. Host liveness and duration reach only the newest turn.
  List<TranscriptRow> rows({
    required bool isNewest,
    required bool turnInProgress,
    required int? turnElapsedMs,
    required bool expanded,
  }) {
    final inputs = (
      isNewest: isNewest,
      turnInProgress: isNewest && turnInProgress,
      turnElapsedMs: isNewest ? turnElapsedMs : null,
      expanded: expanded,
    );
    if (inputs == _inputs) return _rows;
    _inputs = inputs;
    return _rows = _build(
      isNewest: isNewest,
      turnInProgress: turnInProgress,
      turnElapsedMs: turnElapsedMs,
      expanded: expanded,
    );
  }

  List<TranscriptRow> _build({
    required bool isNewest,
    required bool turnInProgress,
    required int? turnElapsedMs,
    required bool expanded,
  }) {
    final timer = this.timer;
    final inProgress = isLive || (isNewest && turnInProgress);
    // Either the turn's live timer row or the bottom fallback row.
    final showsWorkingRow =
        (timer?.isLive ?? false) ||
        (isNewest &&
            turnInProgress &&
            (timer == null || timer.completedAt != null));
    final rows = <TranscriptRow>[];
    final user = turn.user;
    if (user != null && hasRenderableContent(user)) {
      rows.add(TranscriptMessageRow(user));
    }
    if (inProgress) {
      // Desktop parity: a running turn shows every step inline (no steps
      // row, nothing to collapse yet) in transcript order; it folds up and
      // applies the intermediate/final partition only when it completes.
      for (final message in turn.assistantMessages) {
        if (hasRenderableContent(message)) {
          rows.add(
            TranscriptMessageRow(
              message,
              toolResults: toolResults,
              streamingSpinner: !showsWorkingRow,
            ),
          );
        }
      }
    } else if (turn.hasCollapsibleIntermediate) {
      final counts = stepCounts;
      if (counts.isNotEmpty) {
        rows.add(TranscriptStepsRow(turn, counts, expanded: expanded));
        if (expanded) {
          for (final message in turn.intermediate) {
            if (hasRenderableContent(message)) {
              rows.add(TranscriptMessageRow(message, toolResults: toolResults));
            }
          }
        }
      }
    }
    if (!inProgress) {
      for (final message in turn.finalMessages) {
        rows.add(TranscriptMessageRow(message, toolResults: toolResults));
      }
    }
    // The authoritative timer closes every turn. Keeping the completed frame
    // in the transcript produces the desktop-parity "Completed in M:SS" row
    // instead of silently dropping it.
    if (timer != null) {
      rows.add(
        TranscriptTimerRow(
          timer,
          turnKey: turn.key,
          // On reopen, transcript hydration can return the original timer
          // carrier frame while the freshly projected chat summary already
          // knows how long the live turn has run. Preserve that newer host
          // measurement so remounting the row cannot restart it at zero.
          initialElapsedMs: isNewest && inProgress && timer.isLive
              ? turnElapsedMs
              : null,
        ),
      );
    }
    return rows;
  }
}

/// Collects a turn's `tool_result` outcomes across every message, keyed by
/// `toolUseId` — the portal can project a call and its result as separate
/// messages.
Map<String, ToolCallResult> _turnToolResults(ChatTurn turn) {
  final results = <String, ToolCallResult>{};
  final messages = [?turn.user, ...turn.intermediate, ...turn.finalMessages];
  for (final message in messages) {
    for (final part in message.parts) {
      if (part.kind != 'tool_result') continue;
      final id = part.toolUseId;
      final output = part.toolOutput;
      if (id == null || id.isEmpty) continue;
      if (output == null && !part.isToolError) continue;
      results[id] = (content: output ?? 'Error', isError: part.isToolError);
    }
  }
  return results;
}
