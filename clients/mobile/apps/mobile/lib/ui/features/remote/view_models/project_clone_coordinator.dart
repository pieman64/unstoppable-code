import 'dart:async';

import 'package:mobile/data/models/git_remote_url.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/services/api_client.dart';

import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// How long an accepted clone waits for its terminal event before a
/// command-status read, and the foreground time between its reads. The
/// completion event normally settles the clone first (CAN-4875).
const Duration kRemoteProjectCloneStatusInterval = Duration(seconds: 30);

/// Where one project clone stands, for its pending row.
enum RemoteProjectClonePhase {
  /// The submit request has not answered yet.
  submitting,

  /// The desktop is reconnecting; the clone starts when it is back.
  queued,

  /// The desktop is cloning.
  cloning,

  /// The desktop created the project; the snapshot does not list it yet.
  awaitingProject,

  /// The desktop confirmed that the clone failed.
  failed,

  /// The result could not be confirmed. Never resubmitted automatically.
  unknown,
}

/// One clone's pending project row.
final class RemoteProjectClone {
  const RemoteProjectClone({
    required this.id,
    required this.name,
    required this.phase,
    this.failure,
  });

  final int id;

  /// The repository name derived from the URL; the URL itself is not kept.
  final String name;
  final RemoteProjectClonePhase phase;

  /// The desktop's path-free message for a [RemoteProjectClonePhase.failed]
  /// clone, when it sent one.
  final String? failure;

  /// Whether the row offers Dismiss. Rows still working on the desktop do not.
  bool get isDismissible => _isDismissible(phase);
}

bool _isDismissible(RemoteProjectClonePhase phase) => switch (phase) {
  RemoteProjectClonePhase.awaitingProject ||
  RemoteProjectClonePhase.failed ||
  RemoteProjectClonePhase.unknown => true,
  _ => false,
};

/// One submitted clone. Mutated only by its coordinator.
final class _Clone {
  _Clone(this.id, this.name, this.sessionGeneration);

  final int id;
  final String name;
  final int sessionGeneration;
  RemoteProjectClonePhase phase = RemoteProjectClonePhase.submitting;
  String? commandId;
  String? workspaceId;
  String? failure;

  /// Runs out when this clone's terminal event is overdue.
  Timer? statusTimer;

  /// Whether the next status read includes this clone.
  bool statusDue = false;

  /// Whether the desktop may still report this clone's terminal result.
  bool get isUnresolved => switch (phase) {
    RemoteProjectClonePhase.submitting ||
    RemoteProjectClonePhase.queued ||
    RemoteProjectClonePhase.cloning => true,
    _ => false,
  };
}

/// Tracks the projects this phone asked the paired desktop to clone, from
/// submit until the desktop snapshot lists the created project (CAN-3988).
///
/// Clones live in memory for the current pairing only.
final class ProjectCloneCoordinator {
  ProjectCloneCoordinator({
    required this.createProject,
    required this.readStatus,
    required this.commands,
    required this.notify,
    required this.isConnected,
    required this.isBackgrounded,
    required this.sessionGeneration,
    required this.hasProject,
    required this.refreshProjects,
    this.statusInterval = kRemoteProjectCloneStatusInterval,
    RemoteTimerFactory? timer,
  }) : _timer = timer ?? Timer.new;

  final Future<RemoteProjectCreateOutcome> Function(String remoteUrl)
  createProject;
  final Future<BrowserPortalCommandStatusResponse> Function(String commandId)
  readStatus;
  final OwnedCommandRegistry commands;
  final void Function() notify;
  final bool Function() isConnected;
  final bool Function() isBackgrounded;
  final int Function() sessionGeneration;

  /// Whether the current snapshot lists the project [workspaceId].
  final bool Function(String workspaceId) hasProject;

  /// Asks the desktop for a fresh project list and re-reads the snapshot.
  final Future<void> Function() refreshProjects;
  final Duration statusInterval;
  final RemoteTimerFactory _timer;

  final List<_Clone> _clones = [];
  List<RemoteProjectClone>? _view;
  int _nextId = 0;

  /// The read that starts right after a return.
  Timer? _resumeRead;
  bool _readingStatus = false;
  bool _disposed = false;

  /// Pending project rows, oldest first.
  List<RemoteProjectClone> get clones => _view ??= List.unmodifiable([
    for (final clone in _clones)
      RemoteProjectClone(
        id: clone.id,
        name: clone.name,
        phase: clone.phase,
        failure: clone.failure,
      ),
  ]);

  /// Sends one clone of [remoteUrl] and adds its pending row. Resolves to a
  /// message for the Add project sheet when nothing was sent, or null once
  /// the row took over.
  Future<String?> addProject(String remoteUrl) async {
    if (_disposed || !isConnected()) return 'Remote Control is disconnected.';
    final clone = _Clone(
      ++_nextId,
      repositoryNameFromCloneUrl(remoteUrl),
      sessionGeneration(),
    );
    _clones.add(clone);
    _changed();
    final outcome = await createProject(remoteUrl);
    if (!_isCurrent(clone)) return null;
    switch (outcome) {
      case RemoteProjectCreateCompleted(:final workspaceId):
        _created(clone, workspaceId);
      case RemoteProjectCreatePending(
        :final commandId,
        :final queuedWhileReconnecting,
      ):
        clone
          ..commandId = commandId
          ..phase = queuedWhileReconnecting
              ? RemoteProjectClonePhase.queued
              : RemoteProjectClonePhase.cloning;
        // A terminal event that raced ahead of this answer applies here.
        commands.register(
          commandId,
          recordOutcome: false,
          onCompleted: (result) => _completed(clone, result),
          onFailed: (message) => _failed(clone, message),
        );
        _armStatus(clone);
      case RemoteProjectCreateFailed(:final message):
        _failed(clone, message);
      case RemoteProjectCreateUnknown():
        _unknown(clone);
    }
    _changed();
    return null;
  }

  /// Removes a dismissible row. Sends nothing to the desktop.
  void dismiss(int id) {
    final removed = _clones.length;
    _clones.removeWhere(
      (clone) => clone.id == id && _isDismissible(clone.phase),
    );
    if (_clones.length != removed) _changed();
  }

  /// Drops rows whose created project the snapshot now lists.
  void reconcile() {
    final count = _clones.length;
    _clones.removeWhere((clone) {
      final workspaceId = clone.workspaceId;
      return workspaceId != null && hasProject(workspaceId);
    });
    if (_clones.length != count) _changed();
  }

  void pauseStatusReads() {
    _resumeRead?.cancel();
    _resumeRead = null;
    for (final clone in _clones) {
      clone.statusTimer?.cancel();
      clone.statusTimer = null;
    }
  }

  /// Reads every unresolved clone at once on return, since events may have
  /// been missed meanwhile.
  void resumeStatusReads() {
    if (_disposed || _resumeRead != null) return;
    var due = false;
    for (final clone in _clones.where(_needsStatus)) {
      clone.statusTimer?.cancel();
      clone.statusTimer = null;
      clone.statusDue = due = true;
    }
    if (!due) return;
    _resumeRead = _timer(Duration.zero, () {
      _resumeRead = null;
      _readDueStatuses();
    });
  }

  /// Forgets every clone of the discarded pairing.
  void reset() {
    pauseStatusReads();
    _clones.clear();
    _view = null;
  }

  void dispose() {
    _disposed = true;
    reset();
  }

  bool _isCurrent(_Clone clone) =>
      !_disposed &&
      clone.sessionGeneration == sessionGeneration() &&
      _clones.contains(clone);

  void _changed() {
    _view = null;
    if (!_disposed) notify();
  }

  void _completed(_Clone clone, Map<String, dynamic>? result) {
    if (!_isCurrent(clone) || !clone.isUnresolved) return;
    final workspaceId = result?['workspaceId'];
    if (workspaceId is String && workspaceId.isNotEmpty) {
      _created(clone, workspaceId);
      _changed();
    } else {
      // Without an id no snapshot can confirm the project.
      _unknown(clone);
    }
  }

  /// Keeps the row until the snapshot lists [workspaceId], asking the
  /// desktop for its projects once when it is not listed yet.
  void _created(_Clone clone, String workspaceId) {
    _stopStatus(clone);
    clone
      ..workspaceId = workspaceId
      ..phase = RemoteProjectClonePhase.awaitingProject;
    if (hasProject(workspaceId)) {
      _clones.remove(clone);
    } else {
      unawaited(refreshProjects());
    }
  }

  void _failed(_Clone clone, String message) {
    if (!_isCurrent(clone) || !clone.isUnresolved) return;
    _stopStatus(clone);
    clone
      ..phase = RemoteProjectClonePhase.failed
      ..failure = message.trim().isEmpty ? null : message;
    _changed();
  }

  void _unknown(_Clone clone) {
    if (!_isCurrent(clone) || !clone.isUnresolved) return;
    _stopStatus(clone);
    clone.phase = RemoteProjectClonePhase.unknown;
    _changed();
  }

  /// Starts [clone]'s overdue wait. Each clone keeps its own, so a newer
  /// clone is never read on an older clone's schedule.
  void _armStatus(_Clone clone) {
    clone.statusTimer?.cancel();
    clone.statusTimer = null;
    if (_disposed || isBackgrounded() || !_needsStatus(clone)) return;
    clone.statusTimer = _timer(statusInterval, () {
      clone.statusTimer = null;
      clone.statusDue = true;
      _readDueStatuses();
    });
  }

  void _stopStatus(_Clone clone) {
    clone.statusTimer?.cancel();
    clone.statusTimer = null;
    clone.statusDue = false;
  }

  static bool _needsStatus(_Clone clone) =>
      clone.isUnresolved && clone.commandId != null;

  /// One read pass at a time, so reads never overlap; a clone that falls due
  /// meanwhile is read when the pass ends.
  void _readDueStatuses() {
    if (_disposed || _readingStatus || isBackgrounded()) return;
    if (!_clones.any((clone) => clone.statusDue && _needsStatus(clone))) {
      return;
    }
    unawaited(_readStatuses());
  }

  Future<void> _readStatuses() async {
    _readingStatus = true;
    try {
      for (final clone in List.of(_clones.where((c) => c.statusDue))) {
        // A return reads every unresolved clone again.
        if (_disposed || isBackgrounded()) return;
        clone.statusDue = false;
        if (!_isCurrent(clone) || !clone.isUnresolved) continue;
        if (!isConnected()) {
          _armStatus(clone);
          continue;
        }
        final commandId = clone.commandId!;
        final BrowserPortalCommandStatusResponse status;
        try {
          status = await readStatus(commandId);
        } on ApiException catch (error) {
          // The server no longer knows the command; it cannot say whether
          // delivered work stopped.
          if (error.statusCode == 404) _unknown(clone);
          _armStatus(clone);
          continue;
        } catch (_) {
          _armStatus(clone);
          continue; // Transient; the next read asks again.
        }
        if (status.commandId == commandId) _applyStatus(clone, status);
        _armStatus(clone);
      }
    } finally {
      _readingStatus = false;
      _readDueStatuses();
    }
  }

  void _applyStatus(_Clone clone, BrowserPortalCommandStatusResponse status) {
    if (!_isCurrent(clone) || !clone.isUnresolved) return;
    switch (status.status) {
      case BrowserPortalCommandStatus.queued:
        if (clone.phase != RemoteProjectClonePhase.queued) {
          clone.phase = RemoteProjectClonePhase.queued;
          _changed();
        }
      case BrowserPortalCommandStatus.delivered:
        if (clone.phase != RemoteProjectClonePhase.cloning) {
          clone.phase = RemoteProjectClonePhase.cloning;
          _changed();
        }
      case BrowserPortalCommandStatus.completed:
        _completed(clone, status.result);
      case BrowserPortalCommandStatus.failed:
        _failed(clone, status.error ?? '');
      case BrowserPortalCommandStatus.expired:
        _unknown(clone);
    }
  }
}
