import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';

void main() {
  late int notifications;
  late OwnedCommandRegistry registry;

  setUp(() {
    notifications = 0;
    registry = OwnedCommandRegistry(notify: () => notifications++);
  });

  group('register then terminal', () {
    test('a completion records the result and runs the handler', () {
      final results = <Map<String, dynamic>?>[];
      registry.register('cmd-1', onCompleted: results.add);

      final changed = registry.handleCompleted('cmd-1', {
        'id': 'wt-9',
      }, projectionSequence: 4);

      expect(changed, isTrue);
      expect(results, [
        {'id': 'wt-9'},
      ]);
      expect(registry.hasCompleted('cmd-1'), isTrue);
      expect(registry.resultOf('cmd-1'), {'id': 'wt-9'});
      expect(registry.completedProjectionSequence('cmd-1'), 4);
      expect(registry.hasFailed('cmd-1'), isFalse);
      // Event delivery reports the change; the owner notifies per batch.
      expect(notifications, 0);
    });

    test('a failure records the message and surfaces it once', () {
      final failures = <String>[];
      registry.register('cmd-1', onFailed: failures.add);

      final changed = registry.handleFailed(
        'cmd-1',
        'Desktop rejected it.',
        projectionSequence: 0,
      );

      expect(changed, isTrue);
      expect(failures, ['Desktop rejected it.']);
      expect(registry.hasFailed('cmd-1'), isTrue);
      expect(registry.failureMessageFor('cmd-1'), 'Desktop rejected it.');
      expect(registry.failureMessage, 'Desktop rejected it.');
      expect(registry.hasCompleted('cmd-1'), isFalse);
      expect(registry.clearFailureMessage(), isTrue);
      expect(registry.failureMessage, isNull);
      expect(registry.clearFailureMessage(), isFalse);
      // The per-command record outlives the dismissed banner.
      expect(registry.hasFailed('cmd-1'), isTrue);
    });

    test('a command reaches its handler at most once', () {
      var completions = 0;
      registry.register('cmd-1', onCompleted: (_) => completions++);

      registry.handleCompleted('cmd-1', null, projectionSequence: 0);
      final second = registry.handleCompleted(
        'cmd-1',
        null,
        projectionSequence: 0,
      );

      expect(second, isFalse);
      expect(completions, 1);
    });

    test('a later registration replaces the earlier handlers', () {
      final calls = <String>[];
      registry.register('cmd-1', onCompleted: (_) => calls.add('first'));
      registry.register('cmd-1', onCompleted: (_) => calls.add('second'));

      registry.handleCompleted('cmd-1', null, projectionSequence: 0);

      expect(calls, ['second']);
    });

    test('an empty id is never registered', () {
      var completions = 0;
      expect(registry.register('', onCompleted: (_) => completions++), '');
      expect(
        registry.handleCompleted('', null, projectionSequence: 0),
        isFalse,
      );
      expect(completions, 0);
    });

    test('a released command is treated as foreign', () {
      var completions = 0;
      registry.register('cmd-1', onCompleted: (_) => completions++);
      registry.release('cmd-1');

      expect(
        registry.handleCompleted('cmd-1', null, projectionSequence: 0),
        isFalse,
      );
      expect(completions, 0);
      expect(registry.hasCompleted('cmd-1'), isFalse);
    });

    test('internal commands run only their handler', () {
      final calls = <String>[];
      registry.register(
        'read-1',
        recordOutcome: false,
        onCompleted: (_) => calls.add('completed'),
      );
      registry.register(
        'hydrate-1',
        recordOutcome: false,
        onFailed: (message) => calls.add('failed: $message'),
      );

      expect(
        registry.handleCompleted('read-1', {}, projectionSequence: 0),
        isFalse,
      );
      expect(
        registry.handleFailed('hydrate-1', 'Timed out', projectionSequence: 0),
        isFalse,
      );

      expect(calls, ['completed', 'failed: Timed out']);
      expect(registry.hasCompleted('read-1'), isFalse);
      expect(registry.hasFailed('hydrate-1'), isFalse);
      expect(registry.failureMessage, isNull);
    });
  });

  group('terminal then register', () {
    test('an unclaimed completion never surfaces', () {
      expect(
        registry.handleCompleted('foreign', {}, projectionSequence: 0),
        isFalse,
      );
      expect(
        registry.handleFailed('foreign-2', 'Nope', projectionSequence: 0),
        isFalse,
      );

      expect(registry.hasCompleted('foreign'), isFalse);
      expect(registry.hasFailed('foreign-2'), isFalse);
      expect(registry.failureMessage, isNull);
    });

    test('a buffered completion is applied when the id is claimed', () {
      registry.handleCompleted('cmd-1', {'id': 'wt-2'}, projectionSequence: 7);
      final results = <Map<String, dynamic>?>[];

      registry.register('cmd-1', onCompleted: results.add);

      expect(results, [
        {'id': 'wt-2'},
      ]);
      expect(registry.resultOf('cmd-1'), {'id': 'wt-2'});
      // The sequence observed with the event, not at claim time.
      expect(registry.completedProjectionSequence('cmd-1'), 7);
      expect(notifications, 1);
      // Claimed: a duplicate event is foreign again.
      expect(
        registry.handleCompleted('cmd-1', null, projectionSequence: 8),
        isFalse,
      );
    });

    test('a buffered failure is applied and can be rethrown', () {
      registry.handleFailed('cmd-1', 'Rejected early', projectionSequence: 0);
      final failures = <String>[];

      expect(
        () => registry.register(
          'cmd-1',
          onFailed: failures.add,
          throwIfFailed: true,
        ),
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Rejected early',
          ),
        ),
      );
      expect(failures, ['Rejected early']);
      expect(registry.failureMessage, 'Rejected early');
      expect(notifications, 1);
    });

    test('a buffered terminal for an internal command does not notify', () {
      registry.handleFailed('hydrate-1', 'Gone', projectionSequence: 0);
      final failures = <String>[];

      registry.register(
        'hydrate-1',
        recordOutcome: false,
        onFailed: failures.add,
        throwIfFailed: true,
      );

      expect(failures, ['Gone']);
      expect(notifications, 0);
      expect(registry.failureMessage, isNull);
    });

    test('submit claims the id returned by the submission', () async {
      registry.handleCompleted('cmd-1', {}, projectionSequence: 0);
      var completions = 0;

      final id = await registry.submit(
        () async => 'cmd-1',
        onCompleted: (_) => completions++,
      );

      expect(id, 'cmd-1');
      expect(completions, 1);
    });
  });

  test('buffer overflow drops the least recently observed terminal', () {
    final small = OwnedCommandRegistry(notify: () {}, maxUnclaimedTerminals: 2);
    small.handleCompleted('a', {}, projectionSequence: 0);
    small.handleCompleted('b', {}, projectionSequence: 0);
    // Re-observing `a` makes `b` the oldest.
    small.handleCompleted('a', {}, projectionSequence: 0);
    small.handleCompleted('c', {}, projectionSequence: 0);

    small
      ..register('a')
      ..register('b')
      ..register('c');

    expect(small.hasCompleted('a'), isTrue);
    expect(small.hasCompleted('b'), isFalse);
    expect(small.hasCompleted('c'), isTrue);
  });

  test('result ring trimming forgets the oldest completions', () {
    final small = OwnedCommandRegistry(notify: () {}, maxCompletedResults: 2);
    for (final id in ['a', 'b', 'c']) {
      small
        ..register(id)
        ..handleCompleted(id, {'id': id}, projectionSequence: 1);
    }

    expect(small.hasCompleted('a'), isFalse);
    expect(small.completedProjectionSequence('a'), isNull);
    expect(small.resultOf('b'), {'id': 'b'});
    expect(small.resultOf('c'), {'id': 'c'});
  });

  group('waitForResult', () {
    test('resolves with the completion result', () async {
      registry.register('cmd-1');
      final wait = registry.waitForResult(
        'cmd-1',
        timeout: const Duration(seconds: 5),
      );

      registry.handleCompleted('cmd-1', {'chatId': 'c'}, projectionSequence: 0);

      expect(await wait, {'chatId': 'c'});
    });

    test('fails with the failure message', () async {
      registry.register('cmd-1');
      final wait = registry.waitForResult(
        'cmd-1',
        timeout: const Duration(seconds: 5),
      );

      registry.handleFailed('cmd-1', 'Rejected', projectionSequence: 0);

      await expectLater(
        wait,
        throwsA(
          isA<RemoteControlException>().having(
            (e) => e.message,
            'message',
            'Rejected',
          ),
        ),
      );
    });

    test('times out and forgets the waiter', () {
      fakeAsync((async) {
        registry.register('cmd-1');
        Object? error;
        registry
            .waitForResult('cmd-1', timeout: const Duration(seconds: 5))
            .then<void>((_) {}, onError: (Object e) => error = e);

        async.elapse(const Duration(seconds: 5));

        expect(error, isA<TimeoutException>());
        // A late terminal finds no waiter to complete.
        expect(
          registry.handleCompleted('cmd-1', {}, projectionSequence: 0),
          isTrue,
        );
        async.flushMicrotasks();
      });
    });
  });

  for (final succeeds in [true, false]) {
    test('skipped events retain ownership for a late '
        '${succeeds ? "completion" : "rejection"}', () async {
      var completions = 0;
      final failures = <String>[];
      registry.register(
        'pending',
        onCompleted: (_) => completions++,
        onFailed: failures.add,
      );
      final wait = expectLater(
        registry.waitForResult('pending', timeout: const Duration(minutes: 10)),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            contains('check its status'),
          ),
        ),
      );

      registry.invalidateAfterSkippedEvents();
      await wait;

      expect(failures, isEmpty);
      expect(completions, 0);
      expect(registry.hasFailed('pending'), isFalse);
      expect(registry.failureMessage, isNull);
      if (succeeds) {
        registry.handleCompleted('pending', {
          'id': 'created',
        }, projectionSequence: 3);
        expect(completions, 1);
        expect(registry.resultOf('pending'), {'id': 'created'});
      } else {
        registry.handleFailed(
          'pending',
          'Desktop rejected it',
          projectionSequence: 3,
        );
        expect(failures, ['Desktop rejected it']);
        expect(registry.hasFailed('pending'), isTrue);
      }
    });
  }

  test('reset forgets every command and fails pending waits', () async {
    var completions = 0;
    registry
      ..register('owned', onCompleted: (_) => completions++)
      ..register('done')
      ..handleCompleted('done', {}, projectionSequence: 0)
      ..register('failed')
      ..handleFailed('failed', 'Rejected', projectionSequence: 0)
      ..handleCompleted('foreign', {}, projectionSequence: 0)
      ..register('waiting');
    final wait = registry.waitForResult(
      'waiting',
      timeout: const Duration(seconds: 5),
    );

    registry.reset();

    await expectLater(
      wait,
      throwsA(
        isA<RemoteControlException>().having(
          (e) => e.message,
          'message',
          'Remote Control is disconnected.',
        ),
      ),
    );
    expect(registry.hasCompleted('done'), isFalse);
    expect(registry.hasFailed('failed'), isFalse);
    expect(registry.failureMessage, isNull);
    expect(
      registry.handleCompleted('owned', {}, projectionSequence: 0),
      isFalse,
    );
    expect(completions, 0);
    // The foreign terminal buffered before the reset cannot be claimed.
    registry.register('foreign');
    expect(registry.hasCompleted('foreign'), isFalse);
  });
}
