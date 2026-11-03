import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/portal_reconnect_backoff.dart';

void main() {
  PortalReconnectBackoff backoff(double jitter) => PortalReconnectBackoff(
    base: const Duration(seconds: 4),
    cap: const Duration(seconds: 60),
    random: () => jitter,
  );

  List<int> take(PortalReconnectBackoff backoff, int count) => [
    for (var i = 0; i < count; i++) backoff.next().inMilliseconds,
  ];

  test('doubles from the base to the cap', () {
    expect(take(backoff(1), 7), [
      4000,
      8000,
      16000,
      32000,
      60000,
      60000,
      60000,
    ]);
  });

  test('jitter keeps each delay within 80-100% of its step', () {
    expect(take(backoff(0), 6), [3200, 6400, 12800, 25600, 48000, 48000]);
    expect(take(backoff(0.5), 2), [3600, 7200]);
  });

  test('five attempts fit in two minutes even at the shortest jitter', () {
    final delays = take(backoff(0), 6);
    expect(delays.take(5).reduce((a, b) => a + b), lessThan(120000));
    expect(delays.take(6).reduce((a, b) => a + b), greaterThan(120000));
  });

  test('reset starts the streak over', () {
    final b = backoff(1);
    take(b, 4);
    b.reset();
    expect(b.next(), const Duration(seconds: 4));
  });

  test('a long streak stays at the cap', () {
    final b = backoff(1);
    take(b, 100);
    expect(b.next(), const Duration(seconds: 60));
  });

  test('a custom jitter floor scales the shortest delay', () {
    final b = PortalReconnectBackoff(
      base: const Duration(milliseconds: 250),
      cap: const Duration(seconds: 8),
      jitterFloor: 0.5,
      random: () => 0,
    );
    expect(take(b, 2), [125, 250]);
  });

  test('a zero base never waits', () {
    final b = PortalReconnectBackoff(
      base: Duration.zero,
      cap: const Duration(seconds: 60),
      random: () => 1,
    );
    expect(take(b, 3), [0, 0, 0]);
  });
}
