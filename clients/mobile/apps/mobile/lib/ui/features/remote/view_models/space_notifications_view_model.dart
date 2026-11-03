import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'space_notification_menu.dart';

/// Per-space notification choices for the paired Remote Control session
/// (CAN-3615). Mirrors the web `SpaceNotificationSettingsStore`.
///
/// The server owns the choice. This view model only shows what the server
/// has acknowledged: a choice is never shown as selected before its save
/// returns, there is no offline write queue, and an outcome the network left
/// ambiguous is settled by reading the space again rather than by assuming
/// it failed.
final class SpaceNotificationsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  /// [sessionScope] identifies the Remote Control session (and so the
  /// account); whenever it changes after [sessionChanges] notifies, every
  /// choice is forgotten and in-flight results are dropped.
  SpaceNotificationsViewModel({
    required this.repository,
    required this._sessionChanges,
    required Object? Function() sessionScope,
  }) : _sessionScope = sessionScope,
       _scope = sessionScope() {
    _sessionChanges.addListener(_onSessionChanged);
  }

  final SpaceNotificationsRepository repository;
  final Listenable _sessionChanges;
  final Object? Function() _sessionScope;
  Object? _scope;

  final Map<String, _Entry> _entries = {};

  /// The latest read or save per space; any other result is stale.
  final Map<String, Object> _operations = {};
  int _generation = 0;

  /// Changes whenever [reset] runs. An open menu closes when it does.
  int get generation => _generation;

  void _onSessionChanged() {
    final scope = _sessionScope();
    if (scope == _scope) return;
    _scope = scope;
    reset();
  }

  /// Forgets every choice and drops whatever is still in flight, so one
  /// session's choice, or a save it started, never lands in another's menu.
  void reset() {
    _generation += 1;
    _operations.clear();
    _entries.clear();
    notifyListenersSafe();
  }

  /// What the menu for [spaceId] shows. A space that has not been read yet is
  /// loading, with no selection.
  SpaceNotificationMenuState menuStateFor(String spaceId) {
    final entry = _entries[spaceId];
    final snapshot = entry?.snapshot;
    if (entry == null || snapshot == null) {
      final unavailable = entry?.unavailable ?? false;
      final failed = entry?.status == SpaceNotificationMenuStatus.failed;
      return SpaceNotificationMenuState(
        status: unavailable
            ? SpaceNotificationMenuStatus.ready
            : failed
            ? SpaceNotificationMenuStatus.failed
            : SpaceNotificationMenuStatus.loading,
        override: null,
        selectionKnown: false,
        failure: entry?.failure,
        disabledReason: unavailable
            ? SpaceNotificationCopy.writesClosed
            : failed
            ? SpaceNotificationCopy.loadFailed
            : null,
      );
    }
    return SpaceNotificationMenuState(
      status: entry.status,
      override: snapshot.override,
      selectionKnown: true,
      pendingOverride: entry.pendingOverride,
      failure: entry.failure,
      disabledReason: snapshot.writesEnabled
          ? null
          : SpaceNotificationCopy.writesClosed,
    );
  }

  /// Reads the space's saved choice. Called whenever its menu opens.
  Future<void> refresh(String spaceId) async {
    final current = _entries[spaceId];
    if (current != null && current.isBusy) return;
    final generation = _generation;
    final operation = Object();
    _operations[spaceId] = operation;
    final known = current?.snapshot;
    // A known choice stays on screen while it is re-read.
    _put(
      spaceId,
      current == null || known == null
          ? const _Entry(status: SpaceNotificationMenuStatus.loading)
          : _Entry(
              snapshot: known,
              status: current.status,
              failure: current.failure,
            ),
    );
    final SpaceNotificationPolicy policy;
    try {
      policy = await repository.load(spaceId);
    } catch (error) {
      if (!_isCurrent(spaceId, generation, operation)) return;
      _put(
        spaceId,
        _isFailure(error, SpaceNotificationsFailure.notFound)
            ? const _Entry.unavailable()
            : _readFailure(known),
      );
      return;
    }
    if (!_isCurrent(spaceId, generation, operation)) return;
    if (policy.spaceId != spaceId) {
      _put(spaceId, _readFailure(known));
      return;
    }
    // A failure line describes a save against the revision it was shown
    // with; a fresh read at a newer revision replaces it.
    final stale = known != null && policy.revision == known.revision;
    _put(
      spaceId,
      _Entry(
        snapshot: _newest(known, policy),
        status: stale && current?.status == SpaceNotificationMenuStatus.failed
            ? SpaceNotificationMenuStatus.failed
            : SpaceNotificationMenuStatus.ready,
        failure: stale ? current?.failure : null,
      ),
    );
  }

  /// Saves [choice] (null clears the override). Ignored while the space is
  /// loading or saving, when nothing is known yet, when changes are closed,
  /// and when [choice] is already saved.
  Future<void> select(String spaceId, SpaceNotificationLevel? choice) async {
    final current = _entries[spaceId];
    final known = current?.snapshot;
    // One save at a time per space, and never against an unknown revision.
    if (current == null || known == null || current.isBusy) return;
    if (!known.writesEnabled || known.override == choice) return;
    final generation = _generation;
    final operation = Object();
    _operations[spaceId] = operation;
    _put(
      spaceId,
      _Entry(
        snapshot: known,
        status: SpaceNotificationMenuStatus.saving,
        pendingOverride: choice,
      ),
    );
    final SpaceNotificationPolicy saved;
    try {
      saved = await repository.save(
        known.spaceId,
        expectedRevision: known.revision,
        override: choice,
      );
    } catch (error) {
      await _settleRefusal(
        spaceId,
        error,
        known,
        choice,
        generation,
        operation,
      );
      return;
    }
    if (!_isCurrent(spaceId, generation, operation)) return;
    if (saved.spaceId != known.spaceId ||
        saved.revision <= known.revision ||
        saved.override != choice) {
      await _reconcile(spaceId, known, choice, generation, operation);
      return;
    }
    _put(
      spaceId,
      _Entry(snapshot: saved, status: SpaceNotificationMenuStatus.ready),
    );
  }

  Future<void> _settleRefusal(
    String spaceId,
    Object error,
    SpaceNotificationPolicy known,
    SpaceNotificationLevel? choice,
    int generation,
    Object operation,
  ) async {
    if (!_isCurrent(spaceId, generation, operation)) return;
    final failure = error is SpaceNotificationsException
        ? error.failure
        : SpaceNotificationsFailure.ambiguous;
    if (failure == SpaceNotificationsFailure.notFound) {
      _put(spaceId, const _Entry.unavailable());
      return;
    }
    final authoritative = error is SpaceNotificationsException
        ? error.policy
        : null;
    final refusal = switch (failure) {
      SpaceNotificationsFailure.staleRevision =>
        SpaceNotificationCopy.changedElsewhere,
      SpaceNotificationsFailure.deliveryInProgress =>
        SpaceNotificationCopy.deliveryInProgress,
      SpaceNotificationsFailure.writesDisabled =>
        SpaceNotificationCopy.writesClosed,
      _ => null,
    };
    if (refusal != null &&
        authoritative != null &&
        authoritative.spaceId == known.spaceId &&
        authoritative.revision >= known.revision) {
      _put(
        spaceId,
        _Entry(
          snapshot: authoritative,
          status: SpaceNotificationMenuStatus.failed,
          failure: refusal,
        ),
      );
      return;
    }
    // A transport failure, 5xx, or unreadable body does not say whether the
    // write committed.
    if (failure == SpaceNotificationsFailure.ambiguous ||
        failure == SpaceNotificationsFailure.writesDisabled) {
      await _reconcile(spaceId, known, choice, generation, operation);
      return;
    }
    _put(
      spaceId,
      _Entry(
        snapshot: known,
        status: SpaceNotificationMenuStatus.failed,
        failure: SpaceNotificationCopy.saveFailed,
      ),
    );
  }

  /// Settles a save whose outcome never arrived. The write committed only if
  /// the space moved past the revision it was sent against AND now holds the
  /// requested choice; anything else is reported as not saved, with whatever
  /// the server holds shown as selected.
  Future<void> _reconcile(
    String spaceId,
    SpaceNotificationPolicy sentAgainst,
    SpaceNotificationLevel? choice,
    int generation,
    Object operation,
  ) async {
    if (!_isCurrent(spaceId, generation, operation)) return;
    SpaceNotificationPolicy? latest;
    try {
      final read = await repository.load(sentAgainst.spaceId);
      latest =
          read.spaceId == sentAgainst.spaceId &&
              read.revision >= sentAgainst.revision
          ? read
          : null;
    } catch (_) {
      latest = null;
    }
    if (!_isCurrent(spaceId, generation, operation)) return;
    if (latest == null) {
      _put(
        spaceId,
        _Entry(
          snapshot: sentAgainst,
          status: SpaceNotificationMenuStatus.failed,
          failure: SpaceNotificationCopy.unconfirmed,
        ),
      );
      return;
    }
    final advanced = latest.revision > sentAgainst.revision;
    _put(
      spaceId,
      advanced && latest.override == choice
          ? _Entry(snapshot: latest, status: SpaceNotificationMenuStatus.ready)
          : _Entry(
              snapshot: latest,
              status: SpaceNotificationMenuStatus.failed,
              failure: advanced
                  ? SpaceNotificationCopy.changedElsewhere
                  : SpaceNotificationCopy.saveFailed,
            ),
    );
  }

  /// A failed re-read keeps the last acknowledged choice and stays usable;
  /// only a first read with nothing to show reports the failure.
  static _Entry _readFailure(SpaceNotificationPolicy? known) => known == null
      ? const _Entry(
          status: SpaceNotificationMenuStatus.failed,
          failure: SpaceNotificationCopy.loadFailed,
        )
      : _Entry(snapshot: known, status: SpaceNotificationMenuStatus.ready);

  /// A late response never rolls a space back to an older revision.
  static SpaceNotificationPolicy _newest(
    SpaceNotificationPolicy? known,
    SpaceNotificationPolicy incoming,
  ) => known != null && known.revision > incoming.revision ? known : incoming;

  static bool _isFailure(Object error, SpaceNotificationsFailure failure) =>
      error is SpaceNotificationsException && error.failure == failure;

  bool _isCurrent(String spaceId, int generation, Object operation) =>
      !isDisposed &&
      generation == _generation &&
      identical(_operations[spaceId], operation);

  void _put(String spaceId, _Entry entry) {
    _entries[spaceId] = entry;
    notifyListenersSafe();
  }

  @override
  void dispose() {
    _sessionChanges.removeListener(_onSessionChanged);
    super.dispose();
  }
}

class _Entry {
  const _Entry({
    required this.status,
    this.snapshot,
    this.failure,
    this.pendingOverride,
  }) : unavailable = false;

  /// The server does not know this space: choices stay disabled, with why.
  const _Entry.unavailable()
    : status = SpaceNotificationMenuStatus.ready,
      snapshot = null,
      failure = null,
      pendingOverride = null,
      unavailable = true;

  /// The override a save in flight is storing.
  final SpaceNotificationLevel? pendingOverride;

  /// Absent until the space has been read once.
  final SpaceNotificationPolicy? snapshot;
  final SpaceNotificationMenuStatus status;
  final String? failure;
  final bool unavailable;

  bool get isBusy =>
      status == SpaceNotificationMenuStatus.loading ||
      status == SpaceNotificationMenuStatus.saving;
}
