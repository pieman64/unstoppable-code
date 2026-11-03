import 'package:mobile/data/models/remote_portal_event.dart';

import 'fake_remote_control_repository.dart';

/// A [FakeRemoteControlRepository] whose event delivery follows the live
/// repository across a background: batches sent while events are paused are
/// held, then replayed in order when delivery resumes, the way the event
/// stream catches up from its cursor. Delivery starts paused, as it does
/// before the first [resumeEvents].
final class BufferingRemoteControlRepository
    extends FakeRemoteControlRepository {
  final _held = <RemotePortalEventBatch>[];
  bool _paused = true;

  /// Batches [deliver] held because events were paused.
  int heldDeliveries = 0;

  /// Held batches [resumeEvents] has since replayed.
  int replayedDeliveries = 0;

  /// Runs once, inside the next [pauseEvents], after delivery has stopped.
  /// Lets a test send a reply that is guaranteed to arrive while away.
  void Function()? onNextPause;

  bool get eventsPaused => _paused;

  /// Sends [batch] now, or holds it until [resumeEvents] if paused.
  void deliver(RemotePortalEventBatch batch) {
    if (!_paused) {
      eventsController.add(batch);
      return;
    }
    heldDeliveries += 1;
    _held.add(batch);
  }

  @override
  void pauseEvents() {
    super.pauseEvents();
    _paused = true;
    final callback = onNextPause;
    onNextPause = null;
    callback?.call();
  }

  @override
  void resumeEvents() {
    super.resumeEvents();
    _paused = false;
    final held = List.of(_held);
    _held.clear();
    for (final batch in held) {
      replayedDeliveries += 1;
      eventsController.add(batch);
    }
  }
}
