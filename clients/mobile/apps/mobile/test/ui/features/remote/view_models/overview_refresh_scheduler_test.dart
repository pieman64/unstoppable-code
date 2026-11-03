import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/overview_refresh_scheduler.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_state.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show kRemoteFreshResumeAfter;

import '../../../../support/fake_remote_control_repository.dart';

final class _CommandHydrationRepository extends FakeRemoteControlRepository {
  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    return 'hydrate-$requestChatTranscriptCalls';
  }
}

final class _FailNextSnapshotRepository extends FakeRemoteControlRepository {
  bool failNextSnapshot = false;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() {
    if (failNextSnapshot) {
      failNextSnapshot = false;
      snapshotFetches++;
      throw const RemoteControlException('snapshot unavailable');
    }
    return super.fetchSnapshot();
  }
}

/// Holds the next [fetchSnapshot] until [gateNextSnapshot]'s completer
/// settles; later reads answer normally.
final class _GatedSnapshotRepository extends FakeRemoteControlRepository {
  Completer<RemoteSessionSnapshot>? _gate;

  Completer<RemoteSessionSnapshot> gateNextSnapshot() =>
      _gate = Completer<RemoteSessionSnapshot>();

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() {
    final gate = _gate;
    if (gate == null) return super.fetchSnapshot();
    _gate = null;
    snapshotFetches += 1;
    return gate.future;
  }
}

final _start = DateTime(2026, 9, 30);
const _tick = Duration(milliseconds: 1);
final _wt1 = remoteWorktreeKey('ws', 'wt-1');
final _wt2 = remoteWorktreeKey('ws', 'wt-2');

/// Drives an [OverviewRefreshScheduler] under a fake clock. A plain refresh
/// claims the pending request and records its outcome, as the view model's
/// `refresh` does.
final class _Harness {
  _Harness(this.async, {this.debounce = kRemoteStateRefreshDebounce});

  final FakeAsync async;
  final Duration debounce;
  bool connected = true;
  bool backgrounded = false;
  bool hydrationPending = false;
  bool needsOverviewRequest = false;

  /// Outcome of the next reads; null holds a read in flight in [inFlight].
  bool? lands = true;
  final reads = <OverviewFollowUp?>[];
  final inFlight = <Completer<bool>>[];

  late final OverviewRefreshScheduler scheduler = OverviewRefreshScheduler(
    isConnected: () => connected,
    isBackgrounded: () => backgrounded,
    isHydrationPending: () => hydrationPending,
    needsOverviewRequest: () => needsOverviewRequest,
    onRefresh: (followUp) async {
      reads.add(followUp);
      if (followUp == null) scheduler.takePending();
      final applied = switch (lands) {
        final bool lands => lands,
        null => await _hold(),
      };
      if (followUp == null || followUp.countFailure) {
        applied ? scheduler.recordSuccess() : scheduler.recordFailure();
      }
      return applied;
    },
    debounce: debounce,
    clock: () => _start.add(async.elapsed),
  );

  Future<bool> _hold() {
    final read = Completer<bool>();
    inFlight.add(read);
    return read.future;
  }

  int get plainReads => reads.where((read) => read == null).length;
  List<OverviewFollowUp> get followUps => reads.nonNulls.toList();
}

void main() {
  group('OverviewRefreshScheduler', () {
    test('debounces a local request', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler
          ..schedule()
          ..schedule();
        async.elapse(kRemoteStateRefreshDebounce - _tick);
        expect(harness.reads, isEmpty);
        async.elapse(_tick);
        expect(harness.plainReads, 1);
        async.elapse(const Duration(minutes: 5));
        expect(harness.plainReads, 1);
      });
    });

    test('delta requests wait out the interval after a success', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler.recordSuccess();
        async.elapse(const Duration(seconds: 10));
        harness.scheduler.schedule(fromDelta: true);
        async.elapse(const Duration(seconds: 20) - _tick);
        expect(harness.reads, isEmpty);
        async.elapse(_tick);
        expect(harness.plainReads, 1);
      });
    });

    test('a delta request after a quiet interval uses the debounce', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler.recordSuccess();
        async.elapse(kRemoteDeltaRefreshInterval * 2);
        harness.scheduler.schedule(fromDelta: true);
        expect(harness.scheduler.delay, kRemoteStateRefreshDebounce);
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    test('a local request re-arms a delta wait with the debounce', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler
          ..recordSuccess()
          ..schedule(fromDelta: true)
          ..schedule();
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    test('a delta request does not postpone an armed local refresh', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler.recordSuccess();
        harness.scheduler
          ..schedule()
          ..schedule(fromDelta: true);
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    test('failures back off exponentially up to the delta interval', () {
      fakeAsync((async) {
        final scheduler = _Harness(async).scheduler;
        final delays = <Duration>[];
        for (var failure = 0; failure < 7; failure++) {
          delays.add(scheduler.delay);
          scheduler.recordFailure();
        }
        expect(delays, const [
          Duration(milliseconds: 1200),
          Duration(milliseconds: 2400),
          Duration(milliseconds: 4800),
          Duration(milliseconds: 9600),
          Duration(milliseconds: 19200),
          kRemoteDeltaRefreshInterval,
          kRemoteDeltaRefreshInterval,
        ]);
        // A success resets the backoff; only delta requests wait it out.
        scheduler.recordSuccess();
        expect(scheduler.delay, kRemoteDeltaRefreshInterval);
        scheduler.schedule();
        expect(scheduler.delay, kRemoteStateRefreshDebounce);
      });
    });

    test('a zero debounce backs off from one second', () {
      fakeAsync((async) {
        final scheduler = _Harness(async, debounce: Duration.zero).scheduler;
        expect(scheduler.delay, Duration.zero);
        scheduler.recordFailure();
        expect(scheduler.delay, const Duration(seconds: 2));
      });
    });

    test('a failed refresh retries after the backoff', () {
      fakeAsync((async) {
        final harness = _Harness(async)..lands = false;
        harness.scheduler.schedule();
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
        // The caller re-schedules a failed refresh, as the view model does.
        harness.scheduler.schedule();
        async.elapse(kRemoteStateRefreshDebounce * 2 - _tick);
        expect(harness.plainReads, 1);
        async.elapse(_tick);
        expect(harness.plainReads, 2);
      });
    });

    test('reads only while visible, foregrounded, and connected', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final scheduler = harness.scheduler;
        scheduler.setRemoteVisible(false);
        scheduler.schedule();
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);

        harness.backgrounded = true;
        scheduler.setRemoteVisible(true);
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);

        harness
          ..backgrounded = false
          ..connected = false;
        scheduler.schedule();
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);

        harness.connected = true;
        scheduler.schedule();
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    test('hiding cancels the armed read; showing re-arms it', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final scheduler = harness.scheduler..schedule();
        async.elapse(kRemoteStateRefreshDebounce ~/ 2);
        scheduler.setRemoteVisible(false);
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);
        scheduler.setRemoteVisible(true);
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    test('a Remote route keeps reads active over another tab', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final scheduler = harness.scheduler..setRemoteVisible(false);
        final release = scheduler.beginRemoteRouteVisibility();
        expect(scheduler.isVisible, isTrue);
        scheduler.schedule();
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);

        final second = scheduler.beginRemoteRouteVisibility();
        release();
        release();
        expect(scheduler.isVisible, isTrue);
        second();
        expect(scheduler.isVisible, isFalse);
        scheduler.schedule();
        async.elapse(const Duration(minutes: 1));
        expect(harness.plainReads, 1);
      });
    });

    test('cancelArmed keeps the request for the next arm', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final scheduler = harness.scheduler..schedule();
        harness.backgrounded = true;
        scheduler.cancelArmed();
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);
        harness.backgrounded = false;
        scheduler.setRemoteVisible(false);
        scheduler.setRemoteVisible(true);
        async.elapse(kRemoteStateRefreshDebounce);
        expect(harness.plainReads, 1);
      });
    });

    group('CAN-3370 hydration deferral', () {
      test('defers a request until hydration settles', () {
        fakeAsync((async) {
          final harness = _Harness(async)..hydrationPending = true;
          harness.scheduler.schedule();
          async.elapse(const Duration(minutes: 1));
          expect(harness.reads, isEmpty);

          harness.hydrationPending = false;
          harness.scheduler.releaseDeferred();
          expect(harness.reads, isEmpty, reason: 'released after the batch');
          async.flushMicrotasks();
          async.elapse(kRemoteStateRefreshDebounce);
          expect(harness.plainReads, 1);
        });
      });

      test('an armed read that fires during hydration waits for it', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.scheduler.schedule();
          harness.hydrationPending = true;
          async.elapse(const Duration(minutes: 1));
          expect(harness.reads, isEmpty);

          harness.hydrationPending = false;
          harness.scheduler.releaseDeferred();
          async.flushMicrotasks();
          async.elapse(kRemoteStateRefreshDebounce);
          expect(harness.plainReads, 1);
        });
      });

      test('release is a no-op while hydration is pending', () {
        fakeAsync((async) {
          final harness = _Harness(async)..hydrationPending = true;
          harness.scheduler
            ..schedule()
            ..deferWorktreeFollowUp({_wt1}, {_wt1})
            ..releaseDeferred();
          async.elapse(const Duration(minutes: 1));
          expect(harness.reads, isEmpty);
        });
      });

      test('follow-ups from one batch share one read', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.scheduler
            ..deferWorktreeFollowUp({_wt1}, {_wt1})
            ..deferWorktreeFollowUp({_wt2}, {});
          expect(harness.reads, isEmpty);
          async.flushMicrotasks();
          expect(harness.followUps, hasLength(1));
          final followUp = harness.followUps.single;
          expect(followUp.resolvedWorktrees, {_wt1, _wt2});
          expect(followUp.hydratedWorktrees, {_wt1});
          expect(followUp.countFailure, isFalse);
          async.elapse(const Duration(minutes: 1));
          expect(harness.reads, hasLength(1));
        });
      });

      test('a follow-up answers the pending refresh', () {
        fakeAsync((async) {
          final harness = _Harness(async)..hydrationPending = true;
          harness.scheduler
            ..schedule(fromDelta: true)
            ..deferWorktreeFollowUp({_wt1}, {});
          harness.hydrationPending = false;
          harness.scheduler.releaseDeferred();
          async.flushMicrotasks();
          expect(harness.followUps.single.countFailure, isTrue);
          async.elapse(const Duration(minutes: 1));
          expect(harness.reads, hasLength(1));
        });
      });

      test('a refresh that must ask the desktop is not coalesced', () {
        fakeAsync((async) {
          final harness = _Harness(async)..needsOverviewRequest = true;
          harness.scheduler
            ..schedule()
            ..deferWorktreeFollowUp({_wt1}, {});
          async.flushMicrotasks();
          expect(harness.followUps.single.countFailure, isFalse);
          async.elapse(kRemoteStateRefreshDebounce);
          expect(harness.plainReads, 1);
        });
      });

      test('a failed coalesced follow-up re-schedules with backoff', () {
        fakeAsync((async) {
          final harness = _Harness(async)..lands = false;
          harness.scheduler.recordSuccess();
          harness.scheduler
            ..schedule(fromDelta: true)
            ..deferWorktreeFollowUp({_wt1}, {});
          async.flushMicrotasks();
          expect(harness.followUps, hasLength(1));
          harness.lands = true;
          // Still delta-only: waits out the interval from the last success.
          async.elapse(kRemoteDeltaRefreshInterval - _tick);
          expect(harness.plainReads, 0);
          async.elapse(_tick);
          expect(harness.plainReads, 1);
        });
      });
    });

    test('reset forgets requests and backoff but keeps visibility', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final scheduler = harness.scheduler
          ..setRemoteVisible(false)
          ..recordSuccess()
          ..recordFailure()
          ..schedule();
        scheduler.reset();
        expect(scheduler.isVisible, isFalse);
        expect(scheduler.delay, kRemoteStateRefreshDebounce);
        scheduler.setRemoteVisible(true);
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);
      });
    });

    test('a follow-up that outlives its session schedules nothing', () {
      fakeAsync((async) {
        final harness = _Harness(async)..lands = null;
        harness.scheduler
          ..schedule()
          ..deferWorktreeFollowUp({_wt1}, {});
        async.flushMicrotasks();
        expect(harness.followUps, hasLength(1));

        harness.scheduler.reset();
        harness.inFlight.single.complete(false);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, hasLength(1));
      });
    });

    test('dispose drops a queued release and the armed read', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.scheduler
          ..schedule()
          ..deferWorktreeFollowUp({_wt1}, {})
          ..dispose();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 1));
        expect(harness.reads, isEmpty);
      });
    });
  });

  group('CAN-3370 overview reads wait for chat hydration', () {
    const target = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'chat',
    );
    const shellChange = RemotePortalEventBatch(
      events: [
        RemoteStateDeltaEvent(scope: 'overview', requiresOverviewRefresh: true),
      ],
      nextCursor: 2,
    );
    const chatLanded = RemotePortalEventBatch(
      events: [
        RemoteStateSnapshotEvent(
          scope: 'chat',
          targetWorkspaceLocalId: 'ws',
          targetWorktreeLocalId: 'wt',
          targetChatId: 'chat',
          targetChatScope: RemoteChatScope.worktree,
        ),
      ],
      nextCursor: 3,
    );
    RemoteSessionSnapshot unreadChat() => const RemoteSessionSnapshot(
      workspaces: [],
      worktrees: [
        RemoteWorktree(
          localId: 'wt',
          workspaceLocalId: 'ws',
          branch: 'main',
          hasUnread: true,
        ),
      ],
      standaloneChats: [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          title: 'Chat',
          hasUnread: true,
          lastMessageAt: '1',
        ),
      ],
      chatMessages: [
        RemoteChatMessage(
          messageId: 'reply',
          chatId: 'chat',
          scope: RemoteChatScope.worktree,
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Answer',
        ),
      ],
    );

    void publish(
      FakeRemoteControlRepository repo,
      FakeAsync time,
      RemotePortalEventBatch batch,
    ) {
      repo.eventsController.add(batch);
      time.flushMicrotasks();
    }

    void close(
      RemoteControlViewModel vm,
      FakeRemoteControlRepository repo,
      FakeAsync time,
    ) {
      vm.dispose();
      repo.eventsController.close();
      time.flushMicrotasks();
    }

    test('a shell refresh armed before the chat opened waits for it', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        publish(repo, time, shellChange);
        time.elapse(const Duration(milliseconds: 500));
        vm.ensureChatTranscript(target);
        time.elapse(const Duration(seconds: 20));
        expect(repo.snapshotFetches, reads);

        publish(repo, time, shellChange);
        time.elapse(const Duration(seconds: 20));
        expect(repo.snapshotFetches, reads);

        publish(repo, time, chatLanded);
        time.elapse(const Duration(seconds: 2));
        expect(repo.snapshotFetches, reads + 1);
        time.elapse(const Duration(minutes: 1));
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });

    test('a timed-out hydration releases the deferred refresh once', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repo,
          hydrationTimeout: const Duration(seconds: 5),
        );
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        publish(repo, time, shellChange);
        time.elapse(const Duration(seconds: 4));
        expect(repo.snapshotFetches, reads);

        time.elapse(const Duration(seconds: 3));
        // CAN-3631: the first timeout stays quiet while the retry is due.
        expect(vm.chatHydrationError(target), isNull);
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });

    test('a failed hydration command releases the deferred refresh', () {
      fakeAsync((time) {
        final repo = _CommandHydrationRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        time.flushMicrotasks();
        publish(repo, time, shellChange);
        time.elapse(const Duration(seconds: 5));
        expect(repo.snapshotFetches, reads);

        publish(
          repo,
          time,
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                commandId: 'hydrate-1',
                message: 'Desktop busy',
              ),
            ],
            nextCursor: 4,
          ),
        );
        time.elapse(const Duration(seconds: 2));
        expect(vm.chatHydrationError(target), isNull);
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });

    test('a chat load paused in the background holds the return read for '
        'one fresh timeout', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repo,
          clock: () => _start.add(time.elapsed),
        );
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        time.elapse(const Duration(seconds: 3));
        vm.onAppBackgrounded();
        // Past the watchdog, short of the fresh resume, which reads at once.
        time.elapse(kRemoteFreshResumeAfter - const Duration(seconds: 1));
        vm.onAppForegrounded();
        time.elapse(const Duration(seconds: 59));
        expect(repo.snapshotFetches, reads);
        expect(vm.chatHydrationError(target), isNull);

        // Released at the fresh timeout, after the refresh debounce.
        time.elapse(const Duration(seconds: 1) + kRemoteStateRefreshDebounce);
        expect(repo.snapshotFetches, reads + 1);
        expect(vm.chatHydrationError(target), isNull);
        close(vm, repo, time);
      });
    });

    test('app resume during hydration catches up after the chat lands', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        vm.onAppBackgrounded();
        vm.onAppForegrounded();
        time.elapse(const Duration(seconds: 10));
        expect(repo.snapshotFetches, reads);

        publish(repo, time, chatLanded);
        time.elapse(const Duration(seconds: 2));
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });

    // CAN-4875: read receipts settle on their own commands' events and
    // never schedule an overview read, before or after hydration settles.
    test('read-receipt retries read no overview after hydration settles', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository()
          ..supportsChatMarkRead = true
          ..snapshotBuilder = unreadChat
          ..markReadHandler = (_, _) async =>
              throw const RemoteControlException('offline');
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        vm.acknowledgeVisibleChat(target, 'reply');
        time.elapse(const Duration(seconds: 20));
        expect(repo.markReadCalls.length, greaterThan(1));
        expect(repo.snapshotFetches, reads);

        publish(repo, time, chatLanded);
        time.elapse(const Duration(seconds: 40));
        expect(repo.snapshotFetches, reads);
        close(vm, repo, time);
      });
    });

    // CAN-4875: a declined read asks the desktop for one fresh chat
    // projection instead of an overview read, during or after hydration.
    test('a declined read reads no overview after hydration settles', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository()
          ..supportsChatMarkRead = true
          ..snapshotBuilder = unreadChat
          ..markReadHandler = (_, _) async => 'read-1';
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        vm.acknowledgeVisibleChat(target, 'reply');
        time.flushMicrotasks();
        expect(repo.markReadCalls, hasLength(1));
        final chatRequests = repo.requestChatTranscriptCalls;
        publish(
          repo,
          time,
          const RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'read-1',
                result: {'applied': false},
              ),
            ],
            nextCursor: 4,
          ),
        );
        time.elapse(const Duration(seconds: 10));
        expect(repo.requestChatTranscriptCalls, chatRequests + 1);
        expect(repo.snapshotFetches, reads);

        publish(repo, time, chatLanded);
        time.elapse(const Duration(seconds: 40));
        expect(repo.snapshotFetches, reads);
        close(vm, repo, time);
      });
    });

    test('a worktree snapshot during hydration shares the single read', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureChatTranscript(target);
        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        time.flushMicrotasks();
        publish(repo, time, shellChange);
        publish(
          repo,
          time,
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws',
                targetWorktreeLocalId: 'wt',
              ),
            ],
            nextCursor: 4,
          ),
        );
        time.elapse(const Duration(seconds: 5));
        expect(repo.snapshotFetches, reads);
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isTrue,
        );

        publish(repo, time, chatLanded);
        time.elapse(const Duration(seconds: 2));
        expect(repo.snapshotFetches, reads + 1);
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isFalse,
        );
        time.elapse(const Duration(minutes: 1));
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });

    test('coalesced refresh starts the delta interval at its own read', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        time.flushMicrotasks();
        publish(repo, time, shellChange);
        publish(
          repo,
          time,
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws',
                targetWorktreeLocalId: 'wt',
              ),
            ],
            nextCursor: 4,
          ),
        );
        expect(repo.snapshotFetches, reads + 1);

        publish(repo, time, shellChange);
        time.elapse(const Duration(seconds: 2));
        expect(repo.snapshotFetches, reads + 1);
        time.elapse(kRemoteDeltaRefreshInterval);
        expect(repo.snapshotFetches, reads + 2);
        close(vm, repo, time);
      });
    });

    test('failed coalesced refresh backs off before retrying', () {
      fakeAsync((time) {
        final repo = _FailNextSnapshotRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        time.flushMicrotasks();
        repo.failNextSnapshot = true;
        publish(repo, time, shellChange);
        publish(
          repo,
          time,
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws',
                targetWorktreeLocalId: 'wt',
              ),
            ],
            nextCursor: 4,
          ),
        );
        expect(repo.snapshotFetches, reads + 1);

        time.elapse(kRemoteStateRefreshDebounce);
        expect(repo.snapshotFetches, reads + 1);
        time.elapse(kRemoteStateRefreshDebounce);
        expect(repo.snapshotFetches, reads + 2);
        close(vm, repo, time);
      });
    });

    test('a session reset does not strand later refreshes', () {
      fakeAsync((time) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();

        vm.ensureChatTranscript(target);
        publish(repo, time, shellChange);
        vm.disconnect();
        time.flushMicrotasks();
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        publish(repo, time, shellChange);
        time.elapse(const Duration(seconds: 2));
        expect(repo.snapshotFetches, reads + 1);
        close(vm, repo, time);
      });
    });
  });

  group('overview refresh across a session reset', () {
    test('a late follow-up read does not refresh the next session', () {
      fakeAsync((time) {
        final repo = _GatedSnapshotRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        time.flushMicrotasks();

        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        time.flushMicrotasks();
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateDeltaEvent(
                scope: 'overview',
                requiresOverviewRefresh: true,
              ),
            ],
            nextCursor: 2,
          ),
        );
        time.flushMicrotasks();
        final lateRead = repo.gateNextSnapshot();
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws',
                targetWorktreeLocalId: 'wt',
              ),
            ],
            nextCursor: 3,
          ),
        );
        time.flushMicrotasks();
        expect(lateRead.isCompleted, isFalse);

        vm.disconnect();
        time.flushMicrotasks();
        vm.connect('123456');
        time.flushMicrotasks();
        final reads = repo.snapshotFetches;

        lateRead.completeError(const RemoteControlException('late'));
        time.flushMicrotasks();
        time.elapse(const Duration(minutes: 1));
        expect(repo.snapshotFetches, reads);
        vm.dispose();
        repo.eventsController.close();
        time.flushMicrotasks();
      });
    });
  });
}
