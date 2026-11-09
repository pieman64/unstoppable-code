import 'dart:async';
import 'dart:math';

import 'package:mobile/data/models/git_remote_url.dart';

import '../desktop/ipc.dart';
import '../dto.dart';
import '../protocol.dart';

/// The clone request answers once the project exists, which can take minutes.
const _cloneTimeout = Duration(minutes: 15);

const _unsupported =
    "This computer doesn't support adding projects from "
    'your phone.';
const _unreachable = "Couldn't reach your computer. Try again.";
const _noDestination =
    "Your computer didn't provide a folder for new projects.";

/// Matches the computer's own path-free clone failure copy. Raw git errors
/// can name local paths, so they are never shown.
const _cloneFailed =
    'Failed to clone the repository. Check the URL and access, then try again.';

enum DeviceProjectClonePhase {
  /// The computer may still be cloning, or its answer is being read back.
  cloning,

  /// The computer created the project; the inventory does not list it yet.
  awaitingProject,

  /// The computer confirmed the clone failed, or never received it.
  failed,

  /// The computer is not running the clone, but its result is unknown.
  /// Later evidence for the same job can still settle it.
  unknown,
}

/// One pending project row on this computer.
final class DeviceProjectClone {
  const DeviceProjectClone({
    required this.jobId,
    required this.name,
    required this.phase,
    this.failure,
  });

  final String jobId;

  /// The repository name derived from the URL; the URL itself is not kept.
  final String name;
  final DeviceProjectClonePhase phase;

  /// Path-free copy for [DeviceProjectClonePhase.failed].
  final String? failure;

  /// Rows the computer may still be working on cannot be dismissed.
  bool get dismissible => phase != DeviceProjectClonePhase.cloning;
}

/// A lowercase job id the computer's id validation accepts.
String newDeviceCloneJobId() {
  final random = Random.secure();
  final hex = [
    for (var i = 0; i < 16; i++)
      random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ].join();
  return 'mobile-clone-$hex';
}

final class _Attempt {
  _Attempt(this.jobId, this.name, this.generation);
  final String jobId, name;

  /// The connection generation that carried the request.
  final int generation;
  DeviceProjectClonePhase phase = DeviceProjectClonePhase.cloning;
  String? workspaceId, failure;

  /// The request's own answer can no longer arrive.
  bool answerLost = false;
  bool backgroundRequested = false;

  /// Counts matching pushes, so an older job list cannot overwrite them.
  int pushes = 0;

  /// Dismissed while unknown: hidden, but still unresolved.
  bool hidden = false;

  /// While unknown, the user accepted that another clone might duplicate
  /// this one. The result stays unknown.
  bool acknowledged = false;

  /// No authoritative result yet, so later evidence can still settle it.
  bool get unresolved =>
      phase == DeviceProjectClonePhase.cloning ||
      phase == DeviceProjectClonePhase.unknown;
}

/// Adds Personal projects on one connected computer through its existing
/// `workspace:add-from-remote` clone and `clone-jobs:*` lifecycle (CAN-5796).
///
/// A clone is not idempotent: each attempt sends exactly one request with its
/// own job id, and a lost answer is read back from the computer's clone jobs,
/// never resent. Attempts live in memory for this computer's session only.
///
/// Read-back is best effort, so a result can stay unknown. Only the user can
/// then allow another clone, after checking Projects on the computer.
final class DeviceProjectCloneRepository {
  DeviceProjectCloneRepository(
    this.ipc, {
    required this.onChanged,
    required this.onCreated,
    this.newJobId = newDeviceCloneJobId,
  }) {
    _subscription = ipc.events.listen(_event);
  }

  final DesktopIpc ipc;
  final void Function() onChanged;

  /// The computer created a project; its inventory needs a fresh read.
  final void Function() onCreated;
  final String Function() newJobId;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  final _attempts = <_Attempt>[];
  bool _connected = false, _disposed = false, _discovering = false;
  bool _reading = false, _readAgain = false;
  int _generation = 0;

  /// Pending project rows, oldest first.
  List<DeviceProjectClone> get clones => [
    for (final attempt in _attempts)
      if (!attempt.hidden) _clone(attempt),
  ];

  /// The oldest unknown result that still blocks another clone, even when
  /// its row is hidden.
  DeviceProjectClone? get unconfirmed {
    final attempt = _attempts.where(_blocksAdd).firstOrNull;
    return attempt == null ? null : _clone(attempt);
  }

  DeviceProjectClone _clone(_Attempt attempt) => DeviceProjectClone(
    jobId: attempt.jobId,
    name: attempt.name,
    phase: attempt.phase,
    failure: attempt.failure,
  );

  bool _blocksAdd(_Attempt attempt) =>
      attempt.phase == DeviceProjectClonePhase.unknown && !attempt.acknowledged;

  String? get _addRefusal {
    if (_discovering ||
        _attempts.any((a) => a.phase == DeviceProjectClonePhase.cloning)) {
      return 'Wait for the current clone to finish.';
    }
    if (_attempts.any(_blocksAdd)) {
      return "Your computer hasn't confirmed the last clone yet. Check "
          'Projects on your computer.';
    }
    return null;
  }

  void setConnected(bool value) {
    if (_connected == value) return;
    _connected = value;
    _generation++;
    // Pushes may have been missed while offline.
    if (value) unawaited(readBack());
  }

  /// Sends one clone of [remoteUrl] into the computer's default folder.
  /// Resolves to a message when nothing was sent, or null once the pending
  /// row took over. [stillAllowed] rechecks the caller's context just before
  /// the request is sent.
  Future<String?> add(
    String remoteUrl, {
    required bool Function() stillAllowed,
  }) async {
    if (_disposed || !_connected) return 'Connect to your computer first.';
    if (_addRefusal case final refusal?) return refusal;
    final generation = _generation;
    _discovering = true;
    final Object? destination;
    try {
      // The computer owns the folder; this phone passes it back unchanged.
      destination = await ipc.invoke('repo:default-clone-dir');
    } on DesktopIpcRefusal catch (error) {
      return error.code == 'remote_channel_unavailable'
          ? _unsupported
          : _noDestination;
    } on DeviceLinkException {
      return _unreachable;
    } finally {
      _discovering = false;
    }
    if (_disposed ||
        !_connected ||
        generation != _generation ||
        !stillAllowed()) {
      return 'The computer connection changed. Try again.';
    }
    if (destination is! String || destination.isEmpty) return _noDestination;
    // Evidence received during folder discovery can withdraw acknowledgment.
    if (_addRefusal case final refusal?) return refusal;
    final attempt = _Attempt(
      newJobId(),
      repositoryNameFromCloneUrl(remoteUrl),
      generation,
    );
    _attempts.add(attempt);
    onChanged();
    unawaited(_send(attempt, remoteUrl.trim(), destination));
    return null;
  }

  Future<void> _send(_Attempt attempt, String url, String destination) async {
    try {
      final result = deviceChatDto(
        await ipc.invoke('workspace:add-from-remote', [
          {
            'remoteUrl': url,
            'destinationDir': destination,
            'jobId': attempt.jobId,
          },
        ], _cloneTimeout),
      );
      final workspaceId = result is Map ? result['id'] : null;
      if (workspaceId is String && workspaceId.isNotEmpty) {
        _created(attempt, workspaceId);
      } else {
        _lost(attempt);
      }
    } on DesktopIpcNotSent {
      _failed(
        attempt,
        "Couldn't send the request to your computer. Try again.",
      );
    } on DesktopIpcRefusal catch (error) {
      // The computer answered: the clone did not create a project.
      _failed(
        attempt,
        error.code == 'remote_channel_unavailable'
            ? _unsupported
            : _cloneFailed,
      );
    } catch (_) {
      // Timeout or a lost connection: the computer may still be cloning.
      _lost(attempt);
    }
  }

  /// Reads the computer's clone jobs for attempts whose answer was lost or
  /// whose result is unknown.
  /// One read at a time; a request meanwhile reads again afterwards.
  Future<void> readBack() async {
    if (_disposed || !_connected) return;
    if (_reading) {
      _readAgain = true;
      return;
    }
    if (!_attempts.any(_needsReadBack)) return;
    _reading = true;
    final generation = _generation;
    final pushes = {for (final attempt in _attempts) attempt: attempt.pushes};
    try {
      final jobs = deviceChatDto(await ipc.invoke('clone-jobs:list'));
      if (_disposed || generation != _generation || jobs is! List) return;
      for (final attempt in _attempts.where(_needsReadBack).toList()) {
        final job = jobs
            .whereType<Map>()
            .where((job) => job['id'] == attempt.jobId)
            .firstOrNull;
        if (job != null) {
          _apply(attempt, job);
        } else if (_isCurrent(attempt) &&
            attempt.phase == DeviceProjectClonePhase.cloning &&
            pushes[attempt] == attempt.pushes) {
          // Not running there, and no push arrived during the read. Finished
          // foreground jobs, dismissed background jobs and restarts remove
          // jobs, so absence proves neither success nor failure.
          attempt.phase = DeviceProjectClonePhase.unknown;
          onChanged();
        }
      }
    } catch (_) {
      // A later reconnect or refresh reads again.
    } finally {
      _reading = false;
      if (_readAgain) {
        _readAgain = false;
        unawaited(readBack());
      }
    }
  }

  bool _needsReadBack(_Attempt attempt) =>
      attempt.phase == DeviceProjectClonePhase.unknown ||
      (attempt.phase == DeviceProjectClonePhase.cloning &&
          (attempt.answerLost || attempt.generation != _generation));

  /// The user checked Projects on the computer and accepted that another
  /// clone might duplicate [jobId]'s. Lets the next [add] go ahead. Sends
  /// nothing and keeps the result unknown, so later evidence for the job
  /// still settles it. False when [jobId] is no longer unknown here.
  bool acknowledgeUnknown(String jobId) {
    final attempt = _attempts
        .where(
          (a) => a.jobId == jobId && a.phase == DeviceProjectClonePhase.unknown,
        )
        .firstOrNull;
    if (_disposed || !_connected || attempt == null) return false;
    attempt.acknowledged = true;
    return true;
  }

  /// Removes a settled row, or hides an unknown one. Sends nothing.
  void dismiss(String jobId) {
    for (final attempt in _attempts.where((a) => a.jobId == jobId).toList()) {
      if (attempt.phase == DeviceProjectClonePhase.cloning || attempt.hidden) {
        continue;
      }
      // An unknown attempt keeps blocking another clone until settled.
      if (attempt.phase == DeviceProjectClonePhase.unknown) {
        attempt.hidden = true;
      } else {
        _attempts.remove(attempt);
      }
      onChanged();
    }
  }

  /// Drops rows whose created project the inventory now lists.
  void retireListed(Set<String> projectIds) {
    final count = _attempts.length;
    _attempts.removeWhere(
      (a) => a.workspaceId != null && projectIds.contains(a.workspaceId),
    );
    if (_attempts.length != count) onChanged();
  }

  void dispose() {
    _disposed = true;
    _attempts.clear();
    unawaited(_subscription.cancel());
  }

  bool _isCurrent(_Attempt attempt) =>
      !_disposed && attempt.unresolved && _attempts.contains(attempt);

  void _event(Map<String, dynamic> message) {
    if (_disposed || !_connected || message['name'] != 'ipc.push') return;
    final push = deviceChatDto(message['payload']);
    if (push is! Map || push['channel'] != 'clone-jobs:changed') return;
    final args = push['args'];
    if (args is! List || args.isEmpty || args.first is! List) return;
    for (final job in (args.first as List).whereType<Map>()) {
      for (final attempt in _attempts.where((a) => a.jobId == job['id'])) {
        attempt.pushes++;
        _apply(attempt, job);
      }
    }
  }

  void _apply(_Attempt attempt, Map job) {
    if (!_isCurrent(attempt)) return;
    switch (job['status']) {
      case 'running':
        if (attempt.phase == DeviceProjectClonePhase.unknown) {
          // Running again: an earlier acknowledgment no longer applies.
          attempt
            ..phase = DeviceProjectClonePhase.cloning
            ..hidden = false
            ..acknowledged = false;
          onChanged();
        }
        // The computer keeps a finished background job listed until its
        // desktop app or a restart removes it, so a lost answer can often
        // still be read back. The desktop app dismisses succeeded background
        // jobs right away, so the result can stay unknown. False means the
        // job already finished.
        if (job['background'] != true && !attempt.backgroundRequested) {
          attempt.backgroundRequested = true;
          unawaited(
            ipc
                .invoke('clone-jobs:background', [attempt.jobId])
                .then<void>(
                  (_) {},
                  onError: (Object _) => attempt.backgroundRequested = false,
                ),
          );
        }
      case 'succeeded':
        if (job['workspaceId'] case final String id when id.isNotEmpty) {
          _created(attempt, id);
        }
      case 'failed':
        _failed(attempt, _cloneFailed);
    }
  }

  void _lost(_Attempt attempt) {
    if (!_isCurrent(attempt)) return;
    attempt.answerLost = true;
    unawaited(readBack());
  }

  void _created(_Attempt attempt, String workspaceId) {
    if (!_isCurrent(attempt)) return;
    attempt
      ..workspaceId = workspaceId
      ..phase = DeviceProjectClonePhase.awaitingProject
      ..hidden = false;
    onChanged();
    onCreated();
  }

  void _failed(_Attempt attempt, String message) {
    if (!_isCurrent(attempt)) return;
    attempt
      ..phase = DeviceProjectClonePhase.failed
      ..failure = message
      ..hidden = false;
    onChanged();
  }
}
