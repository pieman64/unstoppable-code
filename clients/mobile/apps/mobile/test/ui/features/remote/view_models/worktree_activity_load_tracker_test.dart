import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_activity_load_tracker.dart';

const _timeout = Duration(seconds: 60);
const _failed = ChangedFilesLoadStatus.failed(kChangedFilesLoadFailed);
const _timedOut = ChangedFilesLoadStatus.failed(kChangedFilesTimedOut);

void main() {
  group('WorktreeActivityLoadTracker', () {
    late int notifications;

    WorktreeActivityLoadTracker tracker() {
      notifications = 0;
      return WorktreeActivityLoadTracker(
        timeout: _timeout,
        notify: () => notifications++,
      );
    }

    test('is idle until a load begins, then loading', () {
      fakeAsync((async) {
        final loads = tracker();
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.idle);
        loads.begin('wt');
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
        expect(loads.statusFor('other'), ChangedFilesLoadStatus.idle);
        expect(notifications, 0);
      });
    });

    test('only a read issued after the projection landed settles it', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt');
        // Eager cache reads before the projection prove nothing.
        expect(loads.readSettled('wt', 1), isFalse);
        loads.projected('wt', 2);
        expect(loads.readSettled('wt', 2), isFalse);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
        expect(loads.readSettled('wt', 3), isTrue);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loaded);
        // The deadline was cancelled.
        async.elapse(_timeout * 2);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loaded);
        expect(notifications, 0);
      });
    });

    test('reads before an unsettled load\'s projection predate it, loading '
        'or failed', () {
      fakeAsync((async) {
        final loads = tracker();
        // Without a load, every read stands.
        expect(loads.predatesProjection('wt', 1), isFalse);
        loads
          ..begin('wt')
          ..requested('wt');
        expect(loads.predatesProjection('wt', 1), isTrue);
        async.elapse(_timeout);
        expect(loads.statusFor('wt'), _timedOut);
        expect(loads.predatesProjection('wt', 1), isTrue);
        loads.projected('wt', 2);
        expect(loads.predatesProjection('wt', 2), isTrue);
        expect(loads.predatesProjection('wt', 3), isFalse);
        expect(loads.readSettled('wt', 3), isTrue);
        expect(loads.predatesProjection('wt', 1), isFalse);
        expect(loads.predatesProjection('other', 1), isFalse);
      });
    });

    test('the first landing after a request counts; later ones do not move '
        'it', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt')
          ..projected('wt', 1)
          ..projected('wt', 5);
        expect(loads.readSettled('wt', 2), isTrue);
      });
    });

    test('a load that starts after its request\'s projection landed joins '
        'it', () {
      fakeAsync((async) {
        final loads = tracker()
          ..requested('wt')
          ..projected('wt', 2)
          ..begin('wt');
        expect(loads.predatesProjection('wt', 2), isTrue);
        expect(loads.readSettled('wt', 2), isFalse);
        expect(loads.predatesProjection('wt', 3), isFalse);
        expect(loads.readSettled('wt', 3), isTrue);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loaded);
      });
    });

    test('a landing without a request, or of another worktree, answers '
        'nothing', () {
      fakeAsync((async) {
        final loads = tracker()
          ..projected('wt-1', 0)
          ..requested('wt-2')
          ..projected('wt-2', 0)
          ..begin('wt-1');
        expect(loads.readSettled('wt-1', 1), isFalse);
        loads
          ..requested('wt-1')
          ..projected('wt-2', 1);
        expect(loads.readSettled('wt-1', 2), isFalse);
        expect(loads.statusFor('wt-1'), ChangedFilesLoadStatus.loading);
      });
    });

    test('a new request while loading needs its own landing and keeps the '
        'deadline', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt')
          ..projected('wt', 1);
        async.elapse(const Duration(seconds: 40));
        loads
          ..begin('wt')
          ..requested('wt');
        expect(loads.predatesProjection('wt', 2), isTrue);
        expect(loads.readSettled('wt', 2), isFalse);
        expect(loads.readFailed('wt', 2), isFalse);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
        async.elapse(const Duration(seconds: 20));
        expect(loads.statusFor('wt'), _timedOut);

        loads.projected('wt', 3);
        expect(loads.readSettled('wt', 3), isFalse);
        expect(loads.readSettled('wt', 4), isTrue);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loaded);
      });
    });

    test('the deadline fails a load that never settles, and notifies', () {
      fakeAsync((async) {
        final loads = tracker()..begin('wt');
        async.elapse(_timeout - const Duration(milliseconds: 1));
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
        async.elapse(const Duration(milliseconds: 1));
        expect(loads.statusFor('wt'), _timedOut);
        expect(notifications, 1);
      });
    });

    test('beginning again while loading keeps the original deadline', () {
      fakeAsync((async) {
        final loads = tracker()..begin('wt');
        async.elapse(const Duration(seconds: 40));
        loads.begin('wt');
        async.elapse(const Duration(seconds: 21));
        expect(loads.statusFor('wt'), _timedOut);
      });
    });

    test('a read failure after the projection fails the load', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt');
        expect(loads.readFailed('wt', 1), isFalse);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
        loads.projected('wt', 1);
        expect(loads.readFailed('wt', 2), isTrue);
        expect(loads.statusFor('wt'), _failed);
        async.elapse(_timeout * 2);
        expect(notifications, 0);
      });
    });

    test('a failed projection request fails a load it has not answered', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt');
        expect(loads.requestFailed('wt'), isTrue);
        expect(loads.statusFor('wt'), _failed);

        loads
          ..begin('wt')
          ..requested('wt')
          ..projected('wt', 0);
        // A projection already landed: its read still answers.
        expect(loads.requestFailed('wt'), isFalse);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
      });
    });

    test('a late authoritative read recovers a timed-out load', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt');
        async.elapse(_timeout);
        expect(loads.statusFor('wt'), _timedOut);
        loads.projected('wt', 3);
        expect(loads.readSettled('wt', 3), isFalse);
        expect(loads.readFailed('wt', 4), isFalse);
        expect(loads.statusFor('wt'), _timedOut);
        expect(loads.readSettled('wt', 4), isTrue);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loaded);
      });
    });

    test('a new load and request forget the failed one they replace', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt')
          ..requested('wt');
        loads
          ..projected('wt', 1)
          ..readFailed('wt', 2)
          ..begin('wt')
          ..requested('wt');
        // The failed request's landing does not carry over.
        expect(loads.readSettled('wt', 3), isFalse);
        expect(loads.statusFor('wt'), ChangedFilesLoadStatus.loading);
      });
    });

    test('worktrees load independently', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt-1')
          ..requested('wt-1')
          ..begin('wt-2')
          ..requested('wt-2')
          ..projected('wt-1', 0);
        expect(loads.readSettled('wt-2', 1), isFalse);
        expect(loads.readSettled('wt-1', 1), isTrue);
        expect(loads.statusFor('wt-2'), ChangedFilesLoadStatus.loading);
      });
    });

    test('reset forgets every load and cancels deadlines', () {
      fakeAsync((async) {
        final loads = tracker()
          ..begin('wt-1')
          ..requested('wt-1')
          ..begin('wt-2')
          ..requested('wt-2')
          ..projected('wt-2', 0)
          ..readSettled('wt-2', 1)
          ..reset();
        expect(loads.statusFor('wt-1'), ChangedFilesLoadStatus.idle);
        expect(loads.statusFor('wt-2'), ChangedFilesLoadStatus.idle);
        async.elapse(_timeout * 2);
        expect(notifications, 0);
        expect(loads.readSettled('wt-1', 2), isFalse);
        // The discarded session's request is gone: no landing answers it.
        loads
          ..begin('wt-2')
          ..projected('wt-2', 2);
        expect(loads.readSettled('wt-2', 3), isFalse);
        expect(loads.statusFor('wt-2'), ChangedFilesLoadStatus.loading);
      });
    });

    test('statuses compare by value', () {
      expect(
        const ChangedFilesLoadStatus.failed('a'),
        const ChangedFilesLoadStatus.failed('a'),
      );
      expect(
        const ChangedFilesLoadStatus.failed('a'),
        isNot(const ChangedFilesLoadStatus.failed('b')),
      );
      expect(
        ChangedFilesLoadStatus.loading,
        isNot(ChangedFilesLoadStatus.idle),
      );
    });

    test('only a failed load can be retried; offline cannot', () {
      expect(_failed.canRetry, isTrue);
      expect(_timedOut.canRetry, isTrue);
      expect(
        ChangedFilesLoadStatus.offline.phase,
        ChangedFilesLoadPhase.failed,
      );
      expect(ChangedFilesLoadStatus.offline.error, kChangedFilesOffline);
      expect(ChangedFilesLoadStatus.offline.canRetry, isFalse);
      expect(
        ChangedFilesLoadStatus.offline,
        isNot(const ChangedFilesLoadStatus.failed(kChangedFilesOffline)),
      );
      for (final status in [
        ChangedFilesLoadStatus.idle,
        ChangedFilesLoadStatus.loading,
        ChangedFilesLoadStatus.loaded,
      ]) {
        expect(status.canRetry, isFalse);
      }
    });
  });
}
