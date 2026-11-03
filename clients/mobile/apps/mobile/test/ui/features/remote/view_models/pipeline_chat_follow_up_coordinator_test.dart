import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_chat_follow_up_coordinator.dart';

import '../../../../support/fake_remote_control_repository.dart';

const _plan = RemotePipelineFollowUpOutput.plan;
const _report = RemotePipelineFollowUpOutput.report;

RemotePipelineRun _run({String worktreeLocalId = 'wt-1'}) =>
    RemotePipelineRun.fromJson({
      'localId': 'exec-1',
      'pipelineName': 'Plan and review',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': worktreeLocalId,
      'status': 'failed',
      'chatFollowUp': {'planAvailable': true, 'reportAvailable': true},
    })!;

void main() {
  late FakeRemoteControlRepository repository;
  late OwnedCommandRegistry commands;
  late List<({RemoteWorktreeChatTarget target, String text})> sends;
  late Future<RemoteChatSendResult> Function(RemoteWorktreeChatTarget target)
  sendResult;
  late Set<String> worktrees;
  late bool connected;
  late int generation;
  late int notifications;
  late PipelineChatFollowUpCoordinator coordinator;

  PipelineChatFollowUpCoordinator newCoordinator() =>
      PipelineChatFollowUpCoordinator(
        repository: repository,
        commands: commands,
        send: (target, text) {
          sends.add((target: target, text: text));
          return sendResult(target);
        },
        ownerExists: (workspaceLocalId, worktreeLocalId) =>
            workspaceLocalId == 'ws-1' && worktrees.contains(worktreeLocalId),
        isConnected: () => connected,
        sessionGeneration: () => generation,
        notify: () => notifications++,
      );

  RemotePortalCommandResult inlineAnswer(RemotePipelineFollowUpOutput output) =>
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: output,
        ),
      );

  setUp(() {
    repository = FakeRemoteControlRepository()..followUpChatId = 'chat-owner';
    commands = OwnedCommandRegistry(notify: () {});
    sends = [];
    sendResult = (target) async =>
        RemoteChatSendResult(commandId: 'send-1', chatId: target.chatId);
    worktrees = {'wt-1', 'wt-2'};
    connected = true;
    generation = 1;
    notifications = 0;
    coordinator = newCoordinator();
  });

  test('sends the host prompt once to the run owner chat', () async {
    final receiving = await coordinator.start(_run(), _plan);

    expect(repository.followUpPrepareCalls.single.worktreeLocalId, 'wt-1');
    expect(repository.followUpPrepareCalls.single.output, _plan);
    expect(sends.single.text, 'Review this plan: /plans/invoice-rounding.md');
    expect(sends.single.target.worktreeLocalId, 'wt-1');
    expect(sends.single.target.chatId, 'chat-owner');
    expect(receiving?.chatId, 'chat-owner');
    expect(coordinator.isPending('exec-1'), isFalse);
    expect(coordinator.error('exec-1'), isNull);
  });

  test('a run opened from another worktree still sends to its owner', () async {
    // The owner is wt-2; the screen that opened it is irrelevant here.
    final receiving = await coordinator.start(
      _run(worktreeLocalId: 'wt-2'),
      _report,
    );

    expect(repository.followUpPrepareCalls.single.worktreeLocalId, 'wt-2');
    expect(sends.single.target.worktreeLocalId, 'wt-2');
    expect(receiving?.worktreeLocalId, 'wt-2');
  });

  test(
    'no writable owner chat sends with no chat, so one is created',
    () async {
      repository.followUpChatId = null;
      sendResult = (_) async =>
          const RemoteChatSendResult(commandId: 'send-1', chatId: 'chat-new');

      final receiving = await coordinator.start(_run(), _report);

      expect(sends.single.target.chatId, isNull);
      expect(receiving?.chatId, 'chat-new');
    },
  );

  test('repeated starts while pending prepare and send once', () async {
    final answer = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => answer.future;

    final first = coordinator.start(_run(), _plan);
    expect(coordinator.isPending('exec-1'), isTrue);
    expect(await coordinator.start(_run(), _plan), isNull);
    expect(await coordinator.start(_run(), _report), isNull);

    answer.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: _plan,
          chatId: 'chat-owner',
        ),
      ),
    );
    expect((await first)?.chatId, 'chat-owner');
    expect(repository.followUpPrepareCalls, hasLength(1));
    expect(sends, hasLength(1));
  });

  test('a delayed answer settles from the command event', () async {
    repository.followUpPrepareHandler = () async =>
        const RemotePortalCommandResult(commandId: 'prep-1');

    final pending = coordinator.start(_run(), _report);
    await pumpEventQueue();
    expect(sends, isEmpty);
    commands.handleCompleted(
      'prep-1',
      followUpPreparationJson(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        executionId: 'exec-1',
        output: _report,
        chatId: 'chat-owner',
      ),
      projectionSequence: 0,
    );

    expect((await pending)?.chatId, 'chat-owner');
    expect(sends.single.text, 'Review this report: /runs/exec-1/report.md');
  });

  test('an answer that raced ahead of the response is still used', () async {
    repository.followUpPrepareHandler = () async {
      commands.handleCompleted(
        'prep-1',
        followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: _plan,
          chatId: 'chat-owner',
        ),
        projectionSequence: 0,
      );
      return const RemotePortalCommandResult(commandId: 'prep-1');
    };

    expect((await coordinator.start(_run(), _plan))?.chatId, 'chat-owner');
    expect(sends, hasLength(1));
  });

  test('a host rejection shows its reason and sends nothing', () async {
    repository.followUpPrepareHandler = () async =>
        const RemotePortalCommandResult(commandId: 'prep-1');

    final pending = coordinator.start(_run(), _plan);
    await pumpEventQueue();
    commands.handleFailed(
      'prep-1',
      'This pipeline run does not have a saved plan file.',
      projectionSequence: 0,
    );

    expect(await pending, isNull);
    expect(sends, isEmpty);
    expect(
      coordinator.error('exec-1'),
      'This pipeline run does not have a saved plan file.',
    );
    coordinator.clearError('exec-1');
    expect(coordinator.error('exec-1'), isNull);
  });

  test('an unanswered preparation times out without sending', () {
    fakeAsync((async) {
      repository.followUpPrepareHandler = () async =>
          const RemotePortalCommandResult(commandId: 'prep-1');
      RemoteWorktreeChatTarget? receiving;
      var settled = false;
      unawaited(
        coordinator.start(_run(), _plan).then((value) {
          receiving = value;
          settled = true;
        }),
      );
      async.elapse(kRemotePipelineFollowUpTimeout);
      expect(settled, isTrue);
      expect(receiving, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), contains('Nothing was sent'));
      // A late answer for the released command changes nothing.
      commands.handleCompleted('prep-1', const {}, projectionSequence: 0);
      async.flushMicrotasks();
      expect(sends, isEmpty);
    });
  });

  // One deadline bounds the whole preparation: the request itself and any
  // wait for its command event. The send that follows is not bounded by it.
  group('preparation deadline', () {
    test('a request that never answers times out without sending', () {
      fakeAsync((async) {
        repository.followUpPrepareHandler = () =>
            Completer<RemotePortalCommandResult>().future;
        RemoteWorktreeChatTarget? receiving;
        var settled = false;
        unawaited(
          coordinator.start(_run(), _plan).then((value) {
            receiving = value;
            settled = true;
          }),
        );
        async.flushMicrotasks();
        expect(coordinator.isPending('exec-1'), isTrue);

        async.elapse(kRemotePipelineFollowUpTimeout);

        expect(settled, isTrue);
        expect(receiving, isNull);
        expect(coordinator.isPending('exec-1'), isFalse);
        expect(coordinator.error('exec-1'), contains('Nothing was sent'));
        expect(sends, isEmpty);
      });
    });

    test('a late answer neither sends nor clears a newer attempt', () {
      fakeAsync((async) {
        final stalled = Completer<RemotePortalCommandResult>();
        repository.followUpPrepareHandler = () => stalled.future;
        var firstSettled = false;
        unawaited(
          coordinator.start(_run(), _plan).then((_) => firstSettled = true),
        );
        async.elapse(kRemotePipelineFollowUpTimeout);
        expect(firstSettled, isTrue);
        // Nothing is retried automatically.
        expect(repository.followUpPrepareCalls, hasLength(1));

        final fresh = Completer<RemotePortalCommandResult>();
        repository.followUpPrepareHandler = () => fresh.future;
        RemoteWorktreeChatTarget? receiving;
        unawaited(coordinator.start(_run(), _plan).then((v) => receiving = v));
        async.flushMicrotasks();
        expect(coordinator.error('exec-1'), isNull);

        stalled.complete(inlineAnswer(_plan));
        async.flushMicrotasks();
        expect(sends, isEmpty);
        expect(coordinator.isPending('exec-1'), isTrue);

        fresh.complete(inlineAnswer(_plan));
        async.flushMicrotasks();
        expect(sends, hasLength(1));
        expect(receiving, isNotNull);
        expect(coordinator.isPending('exec-1'), isFalse);
      });
    });

    test('the request and its command event share one deadline', () {
      fakeAsync((async) {
        const requestTime = Duration(seconds: 29);
        repository.followUpPrepareHandler = () => Future.delayed(
          requestTime,
          () => const RemotePortalCommandResult(commandId: 'prep-1'),
        );
        var settled = false;
        unawaited(
          coordinator.start(_run(), _report).then((_) => settled = true),
        );
        async.elapse(requestTime);
        expect(settled, isFalse);

        async.elapse(kRemotePipelineFollowUpTimeout - requestTime);

        expect(settled, isTrue);
        expect(coordinator.error('exec-1'), contains('Nothing was sent'));
        expect(async.pendingTimers, isEmpty);
        // The released command's late answer changes nothing.
        commands.handleCompleted(
          'prep-1',
          inlineAnswer(_report).result,
          projectionSequence: 0,
        );
        async.flushMicrotasks();
        expect(sends, isEmpty);
        expect(coordinator.isPending('exec-1'), isFalse);
      });
    });

    test('a command acknowledged after the deadline is not awaited', () {
      fakeAsync((async) {
        final ack = Completer<RemotePortalCommandResult>();
        repository.followUpPrepareHandler = () => ack.future;
        unawaited(coordinator.start(_run(), _report));
        async.elapse(kRemotePipelineFollowUpTimeout);
        final error = coordinator.error('exec-1');
        final notified = notifications;

        ack.complete(const RemotePortalCommandResult(commandId: 'prep-1'));
        async.flushMicrotasks();
        commands.handleCompleted(
          'prep-1',
          inlineAnswer(_report).result,
          projectionSequence: 0,
        );
        async.flushMicrotasks();

        expect(sends, isEmpty);
        expect(coordinator.error('exec-1'), error);
        expect(notifications, notified);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('a slow send after a timely answer is not cut short', () {
      fakeAsync((async) {
        sendResult = (target) => Future.delayed(
          kRemotePipelineFollowUpTimeout * 2,
          () => RemoteChatSendResult(commandId: 'send-1', chatId: 'chat-owner'),
        );
        RemoteWorktreeChatTarget? receiving;
        unawaited(coordinator.start(_run(), _plan).then((v) => receiving = v));

        async.elapse(kRemotePipelineFollowUpTimeout);
        expect(coordinator.error('exec-1'), isNull);
        expect(coordinator.isPending('exec-1'), isTrue);

        async.elapse(kRemotePipelineFollowUpTimeout);
        expect(receiving?.chatId, 'chat-owner');
        expect(sends, hasLength(1));
        expect(coordinator.error('exec-1'), isNull);
      });
    });
  });

  test('an answer for another run, owner or output is not sent', () async {
    for (final mismatch in [
      {'executionId': 'exec-2'},
      {'worktreeId': 'wt-2'},
      {'output': 'report'},
    ]) {
      repository.followUpPrepareHandler = () async => RemotePortalCommandResult(
        commandId: 'prep-1',
        result: {
          ...followUpPreparationJson(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            executionId: 'exec-1',
            output: _plan,
          ),
          ...mismatch,
        },
      );
      expect(await coordinator.start(_run(), _plan), isNull);
    }
    expect(sends, isEmpty);
  });

  test('offline, unsupported and missing owners send nothing', () async {
    connected = false;
    expect(await coordinator.start(_run(), _plan), isNull);
    expect(coordinator.error('exec-1'), contains('Not connected'));

    connected = true;
    repository.supportsPipelineChatFollowUp = false;
    expect(await coordinator.start(_run(), _plan), isNull);
    expect(coordinator.error('exec-1'), kRemotePipelineFollowUpUnsupported);

    repository.supportsPipelineChatFollowUp = true;
    expect(
      await coordinator.start(_run(worktreeLocalId: 'wt-gone'), _plan),
      isNull,
    );
    expect(
      coordinator.error('exec-1'),
      kRemotePipelineFollowUpOwnerUnavailable,
    );

    expect(repository.followUpPrepareCalls, isEmpty);
    expect(sends, isEmpty);
  });

  test('an owner removed while preparing receives nothing', () async {
    final answer = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => answer.future;
    final pending = coordinator.start(_run(), _plan);
    worktrees.remove('wt-1');
    answer.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: _plan,
        ),
      ),
    );

    expect(await pending, isNull);
    expect(sends, isEmpty);
    expect(
      coordinator.error('exec-1'),
      kRemotePipelineFollowUpOwnerUnavailable,
    );
  });

  test('a not-sent message still opens its receiving chat', () async {
    sendResult = (_) async => throw const RemoteChatSendNotSentException(
      'Your desktop may not have received this message.',
      chatId: 'chat-owner',
    );

    final receiving = await coordinator.start(_run(), _plan);

    expect(receiving?.chatId, 'chat-owner');
    expect(sends, hasLength(1));
    expect(coordinator.error('exec-1'), isNull);
  });

  test('a completion after the session reset sends nothing', () async {
    final answer = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => answer.future;
    final pending = coordinator.start(_run(), _plan);
    generation += 1;
    coordinator.reset();
    // A new session's follow-up for the same run is not blocked or cleared
    // by the stale one.
    final fresh = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => fresh.future;
    final next = coordinator.start(_run(), _plan);
    answer.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: _plan,
        ),
      ),
    );

    expect(await pending, isNull);
    expect(sends, isEmpty);
    expect(coordinator.isPending('exec-1'), isTrue);
    fresh.complete(
      RemotePortalCommandResult(
        commandId: 'prep-2',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'exec-1',
          output: _plan,
        ),
      ),
    );
    await next;
    expect(sends, hasLength(1));
  });

  // A disposed client must not send, record an error or report a change for
  // work that finishes later. Disposal leaves the session generation as it
  // was, so only the coordinator itself can tell the work is stale.
  group('after disposal', () {
    test('a late inline answer sends nothing', () async {
      final answer = Completer<RemotePortalCommandResult>();
      repository.followUpPrepareHandler = () => answer.future;
      final pending = coordinator.start(_run(), _plan);
      // Marking the action pending is the one legitimate change.
      expect(notifications, 1);

      coordinator.dispose();
      answer.complete(inlineAnswer(_plan));

      expect(await pending, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(coordinator.isPending('exec-1'), isFalse);
      expect(notifications, 1);
    });

    test('a late inline failure records and reports nothing', () async {
      final answer = Completer<RemotePortalCommandResult>();
      repository.followUpPrepareHandler = () => answer.future;
      final pending = coordinator.start(_run(), _plan);
      expect(notifications, 1);

      coordinator.dispose();
      answer.completeError(const RemoteControlException('Rejected.'));

      expect(await pending, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(notifications, 1);
    });

    test('a late command answer sends nothing', () async {
      repository.followUpPrepareHandler = () async =>
          const RemotePortalCommandResult(commandId: 'prep-1');
      final pending = coordinator.start(_run(), _report);
      await pumpEventQueue();
      expect(notifications, 1);

      coordinator.dispose();
      commands.handleCompleted(
        'prep-1',
        inlineAnswer(_report).result,
        projectionSequence: 0,
      );

      expect(await pending, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(notifications, 1);
    });

    test('a late command failure records and reports nothing', () async {
      repository.followUpPrepareHandler = () async =>
          const RemotePortalCommandResult(commandId: 'prep-1');
      final pending = coordinator.start(_run(), _report);
      await pumpEventQueue();

      coordinator.dispose();
      commands.handleFailed('prep-1', 'Rejected.', projectionSequence: 0);

      expect(await pending, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(notifications, 1);
    });

    test('a command id answered after disposal is not awaited', () async {
      final answer = Completer<RemotePortalCommandResult>();
      repository.followUpPrepareHandler = () => answer.future;
      final pending = coordinator.start(_run(), _plan);

      coordinator.dispose();
      answer.complete(const RemotePortalCommandResult(commandId: 'prep-1'));

      // Settles at once instead of waiting for an event or the watchdog.
      expect(await pending, isNull);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(notifications, 1);
    });

    test('a new start prepares, sends and reports nothing', () async {
      coordinator.dispose();

      expect(await coordinator.start(_run(), _plan), isNull);
      expect(repository.followUpPrepareCalls, isEmpty);
      expect(sends, isEmpty);
      expect(coordinator.error('exec-1'), isNull);
      expect(coordinator.isPending('exec-1'), isFalse);
      expect(notifications, 0);
    });
  });

  test('a reset alone makes a late answer stale', () async {
    final answer = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => answer.future;
    final pending = coordinator.start(_run(), _plan);

    // Same generation: nothing but the reset marks the attempt stale.
    coordinator.reset();
    answer.complete(inlineAnswer(_plan));

    expect(await pending, isNull);
    expect(sends, isEmpty);
    expect(coordinator.error('exec-1'), isNull);
    expect(notifications, 1);

    // The coordinator stays usable after a reset.
    repository.followUpPrepareHandler = null;
    expect((await coordinator.start(_run(), _plan))?.chatId, 'chat-owner');
    expect(sends, hasLength(1));
  });

  // Invariants over seeded interleavings of taps, inline answers, command
  // acknowledgements and events, failures, resets, disposal and elapsed
  // time: each accepted action prepares at most once and sends at most once,
  // every send targets the captured owner before that action's deadline,
  // every action settles by its deadline, failures, dismissals and stale or
  // late answers send nothing, and after disposal nothing prepares, sends,
  // records an error or reports a change.
  test('seeded event sequences keep the follow-up invariants', () {
    for (var seed = 0; seed < 200; seed++) {
      fakeAsync((async) {
        final random = Random(seed);
        final reason = 'seed $seed';
        repository.followUpPrepareCalls.clear();
        sends.clear();
        final sendTimes = <Duration>[];
        sendResult = (target) async {
          sendTimes.add(async.elapsed);
          return RemoteChatSendResult(commandId: 'send', chatId: target.chatId);
        };
        coordinator = newCoordinator();
        ({int prepares, int sends, int notifications})? atDisposal;
        final answers =
            <({Completer<RemotePortalCommandResult> answer, Duration at})>[];
        repository.followUpPrepareHandler = () {
          final answer = Completer<RemotePortalCommandResult>();
          answers.add((answer: answer, at: async.elapsed));
          return answer.future;
        };
        Map<String, dynamic> answerFor(int index) {
          final call = repository.followUpPrepareCalls[index];
          return followUpPreparationJson(
            workspaceLocalId: call.workspaceLocalId,
            worktreeLocalId: call.worktreeLocalId,
            executionId: call.executionId,
            output: call.output,
          );
        }

        final acknowledged = <({String commandId, int index})>[];
        var settled = 0;
        var started = 0;
        final staleAnswers = <Completer<RemotePortalCommandResult>>{};
        void markOpenStale() => staleAnswers.addAll(
          answers.map((a) => a.answer).where((a) => !a.isCompleted),
        );
        for (var step = 0; step < 10; step++) {
          final open = answers.indexed
              .where((entry) => !entry.$2.answer.isCompleted)
              .toList();
          switch (random.nextInt(9)) {
            case 0 || 1:
              started++;
              unawaited(
                coordinator
                    .start(
                      _run(
                        worktreeLocalId: random.nextBool() ? 'wt-1' : 'wt-2',
                      ),
                      random.nextBool() ? _plan : _report,
                    )
                    .then((_) => settled++),
              );
            case 2:
              if (open.isNotEmpty) {
                final (index, entry) = open.first;
                entry.answer.complete(
                  RemotePortalCommandResult(
                    commandId: 'prep-$seed-$step',
                    result: answerFor(index),
                  ),
                );
              }
            case 3:
              if (open.isNotEmpty) {
                open.first.$2.answer.completeError(
                  const RemoteControlException('Rejected by the desktop.'),
                );
              }
            case 4:
              markOpenStale();
              generation += 1;
              coordinator.reset();
            case 5:
              // A reset with no generation change still discards the attempt.
              markOpenStale();
              coordinator.reset();
            case 6:
              if (atDisposal == null) {
                markOpenStale();
                coordinator.dispose();
                atDisposal = (
                  prepares: repository.followUpPrepareCalls.length,
                  sends: sends.length,
                  notifications: notifications,
                );
              }
            case 7:
              // The relay stops waiting; the answer follows as an event.
              if (open.isNotEmpty) {
                final (index, entry) = open.first;
                final commandId = 'prep-$seed-$step';
                entry.answer.complete(
                  RemotePortalCommandResult(commandId: commandId),
                );
                acknowledged.add((commandId: commandId, index: index));
              }
            case 8:
              if (acknowledged.isNotEmpty) {
                final event = acknowledged.removeAt(0);
                commands.handleCompleted(
                  event.commandId,
                  answerFor(event.index),
                  projectionSequence: 0,
                );
              }
          }
          async.flushMicrotasks();
          async.elapse(Duration(seconds: 4 * random.nextInt(4)));
        }

        // Every accepted action settles by its deadline without help.
        async.elapse(kRemotePipelineFollowUpTimeout);
        expect(settled, started, reason: reason);
        expect(coordinator.isPending('exec-1'), isFalse, reason: reason);
        final settledSends = sends.length;
        // Late answers and events change nothing.
        for (final (index, entry) in answers.indexed) {
          if (!entry.answer.isCompleted) {
            entry.answer.complete(
              RemotePortalCommandResult(
                commandId: 'late-$index',
                result: answerFor(index),
              ),
            );
          }
        }
        for (final event in acknowledged) {
          commands.handleCompleted(
            event.commandId,
            answerFor(event.index),
            projectionSequence: 0,
          );
        }
        async.flushMicrotasks();
        expect(sends, hasLength(settledSends), reason: reason);
        expect(async.pendingTimers, isEmpty, reason: reason);

        expect(
          sends.length,
          lessThanOrEqualTo(answers.length - staleAnswers.length),
          reason: reason,
        );
        for (final (index, send) in sends.indexed) {
          final sentAt = sendTimes[index];
          expect(
            repository.followUpPrepareCalls.indexed.any(
              (call) =>
                  call.$2.worktreeLocalId == send.target.worktreeLocalId &&
                  sentAt - answers[call.$1].at < kRemotePipelineFollowUpTimeout,
            ),
            isTrue,
            reason: '$reason send $index',
          );
        }
        if (atDisposal case final disposed?) {
          expect(
            repository.followUpPrepareCalls,
            hasLength(disposed.prepares),
            reason: reason,
          );
          expect(sends, hasLength(disposed.sends), reason: reason);
          expect(notifications, disposed.notifications, reason: reason);
          expect(coordinator.error('exec-1'), isNull, reason: reason);
        }
      });
    }
  });
}
