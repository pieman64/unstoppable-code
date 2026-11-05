import 'dart:async';

import 'remote_identity.dart';

import 'package:mobile/ui/core/files/changed_files_load_status.dart';
export 'package:mobile/ui/core/files/changed_files_load_status.dart';

/// One load of a worktree's changed files, from its start to an
/// authoritative read, a failure, or the deadline.
final class _LoadCycle {
  Timer? deadline;
}

/// Tracks each worktree's changed-file load, keyed by worktree local id.
///
/// The server cache answers reads before the desktop projects the worktree,
/// so a settled read only ends a load once it was issued after the
/// projection of the latest projection request landed. A load that starts
/// while a request is in flight joins it, even when its projection already
/// landed; a new request needs its own landing. Every cycle has a deadline;
/// a read or request failure, or the deadline, ends it as failed. A failed
/// cycle's projection can still land and be read afterwards; that late
/// authoritative result replaces the failure until a new cycle starts.
/// Callers report requests, landings and read generations; the tracker never
/// issues requests.
final class WorktreeActivityLoadTracker {
  WorktreeActivityLoadTracker({
    required this.timeout,
    required this.notify,
    RemoteTimerFactory? timer,
  }) : _timer = timer ?? Timer.new;

  /// Bound on one cycle.
  final Duration timeout;

  /// Reports a deadline that ended a cycle. Other transitions are reported
  /// by the caller, which learns of them from the return values.
  final void Function() notify;

  final RemoteTimerFactory _timer;

  final Map<String, _LoadCycle> _cycles = {};
  final Map<String, ChangedFilesLoadStatus> _ended = {};

  /// Failed cycles a late projection and read may still answer.
  final Map<String, _LoadCycle> _failed = {};

  /// Each worktree's latest projection request: the activity-read generation
  /// when its projection landed, or null until it lands. Only reads issued
  /// after it can settle a load.
  final Map<String, int?> _projectedAfter = {};

  ChangedFilesLoadStatus statusFor(String worktreeLocalId) =>
      _cycles.containsKey(worktreeLocalId)
      ? ChangedFilesLoadStatus.loading
      : _ended[worktreeLocalId] ?? ChangedFilesLoadStatus.idle;

  /// Starts loading [worktreeLocalId] unless a cycle is already loading,
  /// which keeps its deadline. Does not notify: callers may be building.
  void begin(String worktreeLocalId) {
    if (_cycles.containsKey(worktreeLocalId)) return;
    _failed.remove(worktreeLocalId);
    final cycle = _cycles[worktreeLocalId] = _LoadCycle();
    cycle.deadline = _timer(timeout, () {
      cycle.deadline = null;
      if (_end(
        worktreeLocalId,
        cycle,
        const ChangedFilesLoadStatus.failed(kChangedFilesTimedOut),
      )) {
        notify();
      }
    });
  }

  /// A projection request for [worktreeLocalId] went out. Earlier landings
  /// no longer settle a load; only this request's landing can.
  void requested(String worktreeLocalId) {
    _projectedAfter[worktreeLocalId] = null;
  }

  /// The desktop projected [worktreeLocalId] while [readGeneration] was its
  /// latest activity-read generation. The first landing after a request
  /// answers it.
  void projected(String worktreeLocalId, int readGeneration) {
    if (!_projectedAfter.containsKey(worktreeLocalId)) return;
    _projectedAfter[worktreeLocalId] ??= readGeneration;
  }

  /// Whether [worktreeLocalId] has an unsettled load, loading or failed,
  /// that a read issued at [readGeneration] cannot settle: the read went
  /// out before the latest request's projection landed.
  bool predatesProjection(String worktreeLocalId, int readGeneration) {
    if (!_cycles.containsKey(worktreeLocalId) &&
        !_failed.containsKey(worktreeLocalId)) {
      return false;
    }
    final projectedAfter = _projectedAfter[worktreeLocalId];
    return projectedAfter == null || readGeneration <= projectedAfter;
  }

  /// A read issued at [readGeneration] wrote an authoritative result.
  /// Returns whether the status changed.
  bool readSettled(String worktreeLocalId, int readGeneration) =>
      _endAfterProjection(
        _cycles[worktreeLocalId] ?? _failed[worktreeLocalId],
        worktreeLocalId,
        readGeneration,
        ChangedFilesLoadStatus.loaded,
      );

  /// A read issued at [readGeneration] failed. A read that went out before
  /// the projection landed proves nothing; the deadline still bounds the
  /// cycle. Returns whether the status changed.
  bool readFailed(String worktreeLocalId, int readGeneration) =>
      _endAfterProjection(
        _cycles[worktreeLocalId],
        worktreeLocalId,
        readGeneration,
        const ChangedFilesLoadStatus.failed(kChangedFilesLoadFailed),
      );

  /// The projection request failed. Returns whether the status changed.
  bool requestFailed(String worktreeLocalId) {
    final cycle = _cycles[worktreeLocalId];
    if (cycle == null || _projectedAfter[worktreeLocalId] != null) {
      return false;
    }
    return _end(
      worktreeLocalId,
      cycle,
      const ChangedFilesLoadStatus.failed(kChangedFilesLoadFailed),
    );
  }

  bool _endAfterProjection(
    _LoadCycle? cycle,
    String worktreeLocalId,
    int readGeneration,
    ChangedFilesLoadStatus status,
  ) {
    final projectedAfter = _projectedAfter[worktreeLocalId];
    if (cycle == null ||
        projectedAfter == null ||
        readGeneration <= projectedAfter) {
      return false;
    }
    return _end(worktreeLocalId, cycle, status);
  }

  bool _end(
    String worktreeLocalId,
    _LoadCycle cycle,
    ChangedFilesLoadStatus status,
  ) {
    if (!identical(_cycles[worktreeLocalId], cycle) &&
        !identical(_failed[worktreeLocalId], cycle)) {
      return false;
    }
    cycle.deadline?.cancel();
    cycle.deadline = null;
    _cycles.remove(worktreeLocalId);
    _failed.remove(worktreeLocalId);
    if (status.phase == ChangedFilesLoadPhase.failed) {
      _failed[worktreeLocalId] = cycle;
    }
    _ended[worktreeLocalId] = status;
    return true;
  }

  /// Forgets every cycle of the discarded session and cancels deadlines.
  void reset() {
    for (final cycle in _cycles.values) {
      cycle.deadline?.cancel();
    }
    _cycles.clear();
    _ended.clear();
    _failed.clear();
    _projectedAfter.clear();
  }
}
