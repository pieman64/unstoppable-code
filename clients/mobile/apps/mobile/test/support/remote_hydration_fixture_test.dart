import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';

import 'remote_hydration_fixture.dart';

void main() {
  RemotePortalEventBatch batch(int cursor) =>
      RemotePortalEventBatch(events: const [], nextCursor: cursor);

  test('holds deliveries while paused and replays them in order', () async {
    final repository = BufferingRemoteControlRepository();
    final received = <int?>[];
    repository.events.listen((b) => received.add(b.nextCursor));

    repository.resumeEvents();
    repository.deliver(batch(1));
    await pumpEventQueue();
    expect(received, [1]);

    repository.pauseEvents();
    repository
      ..deliver(batch(2))
      ..deliver(batch(3));
    await pumpEventQueue();
    expect(received, [1]);
    expect(repository.heldDeliveries, 2);
    expect(repository.replayedDeliveries, 0);

    repository.resumeEvents();
    await pumpEventQueue();
    expect(received, [1, 2, 3]);
    expect(repository.replayedDeliveries, 2);

    repository.resumeEvents();
    await pumpEventQueue();
    expect(received, [1, 2, 3]);
  });

  test('runs the next-pause callback once, after delivery stops', () async {
    final repository = BufferingRemoteControlRepository()..resumeEvents();
    final received = <int?>[];
    repository.events.listen((b) => received.add(b.nextCursor));
    var calls = 0;
    repository.onNextPause = () {
      calls += 1;
      expect(repository.eventsPaused, isTrue);
      repository.deliver(batch(7));
    };

    repository
      ..pauseEvents()
      ..pauseEvents();
    await pumpEventQueue();
    expect(calls, 1);
    expect(received, isEmpty);

    repository.resumeEvents();
    await pumpEventQueue();
    expect(received, [7]);
  });
}
