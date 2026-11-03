import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_dispatcher.dart';

import '../../../../support/fake_remote_control_repository.dart';

void main() {
  late FakeRemoteControlRepository repository;
  late OwnedCommandRegistry commands;
  late PipelineDispatcher dispatcher;
  late bool connected;

  PipelineDispatcher build() => PipelineDispatcher(
    repository: repository,
    commands: commands,
    isConnected: () => connected,
    notify: () {},
  );

  setUp(() {
    repository = FakeRemoteControlRepository();
    commands = OwnedCommandRegistry(notify: () {});
    connected = true;
    dispatcher = build();
  });

  tearDown(() => dispatcher.dispose());

  Future<void> loadDeploy() => dispatcher.loadForm(
    workspaceLocalId: 'ws',
    worktreeLocalId: 'wt',
    pipelineId: 'deploy',
  );
  RemotePipelineFormState? deployForm() =>
      dispatcher.formState(worktreeLocalId: 'wt', pipelineId: 'deploy');
  Future<void> dispatchDeploy([Map<String, String> inputs = const {}]) =>
      dispatcher.dispatch(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        pipelineId: 'deploy',
        inputs: inputs,
      );
  RemotePipelineDispatchState? deployDispatch() =>
      dispatcher.dispatchState(worktreeLocalId: 'wt', pipelineId: 'deploy');

  group('loadForm', () {
    test('an inline small-RPC result loads the form', () async {
      repository.pipelineFormResult = {
        'dispatchInputs': {
          'environment': {'type': 'string', 'required': true},
        },
      };
      await loadDeploy();
      final state = deployForm();
      expect(state, isA<RemotePipelineFormLoaded>());
      expect(
        (state! as RemotePipelineFormLoaded).form.inputs.single.name,
        'environment',
      );
    });

    test('a timed-out server wait settles from the command event', () async {
      repository.pipelineFormResult = null;
      await loadDeploy();
      expect(deployForm(), isA<RemotePipelineFormLoading>());
      commands.handleCompleted('pipeline-get-1', {
        'dispatchInputs': <String, dynamic>{},
      }, projectionSequence: 0);
      expect(deployForm(), isA<RemotePipelineFormLoaded>());
    });

    test('a desktop rejection fails the form with its message', () async {
      repository.pipelineFormResult = null;
      await loadDeploy();
      commands.handleFailed(
        'pipeline-get-1',
        'Pipeline not found.',
        projectionSequence: 0,
      );
      expect(
        (deployForm()! as RemotePipelineFormFailed).message,
        'Pipeline not found.',
      );
    });

    test('a silent desktop fails the form after the watchdog', () {
      fakeAsync((async) {
        repository.pipelineFormResult = null;
        dispatcher.dispose();
        dispatcher = build();
        unawaited(loadDeploy());
        async.elapse(kRemotePipelineFormTimeout);
        expect(deployForm(), isA<RemotePipelineFormFailed>());
      });
    });

    test('a late form answer cannot overwrite a newer load', () {
      fakeAsync((async) {
        dispatcher.dispose();
        dispatcher = build();
        final first = Completer<void>();
        repository.pipelineFormGate = first;
        repository.pipelineFormResult = {
          'dispatchInputs': {
            'late': {'type': 'string'},
          },
        };
        unawaited(loadDeploy());
        async.flushMicrotasks();
        async.elapse(kRemotePipelineFormTimeout);
        expect(deployForm(), isA<RemotePipelineFormFailed>());

        final second = Completer<void>();
        repository.pipelineFormGate = second;
        unawaited(loadDeploy());
        async.flushMicrotasks();
        final retry = deployForm();
        expect(retry, isA<RemotePipelineFormLoading>());

        first.complete();
        async.flushMicrotasks();
        expect(deployForm(), same(retry));

        repository.pipelineFormResult = {
          'dispatchInputs': {
            'environment': {'type': 'string'},
          },
        };
        second.complete();
        async.flushMicrotasks();
        expect(
          (deployForm()! as RemotePipelineFormLoaded).form.inputs.single.name,
          'environment',
        );
      });
    });

    test('disconnected fails immediately', () async {
      connected = false;
      await loadDeploy();
      expect(
        (deployForm()! as RemotePipelineFormFailed).message,
        'Not connected to a desktop.',
      );
      expect(repository.pipelineFormRequests, isEmpty);
    });
  });

  group('dispatch', () {
    test('success opens the run named by the result', () async {
      await dispatchDeploy({'environment': 'staging'});
      expect(deployDispatch(), isA<RemotePipelineDispatchSubmitting>());
      expect(repository.pipelineDispatches.single.inputs, {
        'environment': 'staging',
      });
      commands.handleCompleted('pipeline-run-1', {
        'executionId': 'exec-9',
      }, projectionSequence: 0);
      expect(
        (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
        'exec-9',
      );
    });

    test('a result without executionId falls back to the command id', () async {
      await dispatchDeploy();
      commands.handleCompleted('pipeline-run-1', null, projectionSequence: 0);
      expect(
        (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
        'pipeline-run-1',
      );
    });

    test('a run event tagged with the command settles it first', () async {
      await dispatchDeploy();
      expect(
        dispatcher.observeRunStarted(
          commandId: 'pipeline-run-1',
          executionId: 'exec-3',
        ),
        isTrue,
      );
      expect(
        (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
        'exec-3',
      );
      // The later terminal event is a no-op.
      commands.handleCompleted('pipeline-run-1', {
        'executionId': 'other',
      }, projectionSequence: 0);
      expect(
        (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
        'exec-3',
      );
    });

    test('a second tap while submitting sends nothing', () async {
      final gate = Completer<String>();
      repository.pipelineDispatchGate = gate;
      unawaited(dispatchDeploy());
      unawaited(dispatchDeploy());
      await Future<void>.delayed(Duration.zero);
      expect(repository.pipelineDispatches, hasLength(1));
      gate.complete('pipeline-run-1');
    });

    test('a desktop rejection fails with its message', () async {
      await dispatchDeploy();
      commands.handleFailed(
        'pipeline-run-1',
        'Pipeline input "environment" is required',
        projectionSequence: 0,
      );
      expect(
        (deployDispatch()! as RemotePipelineDispatchFailed).message,
        'Pipeline input "environment" is required',
      );
    });

    test('an unknown send outcome never retries', () async {
      repository.pipelineDispatchError =
          const RemotePipelineDispatchOutcomeUnknownException('lost');
      await dispatchDeploy();
      expect(
        (deployDispatch()! as RemotePipelineDispatchFailed).message,
        kRemotePipelineDispatchUnconfirmed,
      );
      expect(repository.pipelineDispatches, hasLength(1));
    });

    test('a silent desktop fails after the watchdog', () {
      fakeAsync((async) {
        dispatcher.dispose();
        dispatcher = build();
        unawaited(dispatchDeploy());
        async.flushMicrotasks();
        async.elapse(kRemotePipelineDispatchTimeout);
        expect(
          (deployDispatch()! as RemotePipelineDispatchFailed).message,
          kRemotePipelineDispatchUnconfirmed,
        );
      });
    });

    test('a queued send stays pending until its command completes', () {
      fakeAsync((async) {
        repository.pipelineDispatchError =
            const RemotePipelineDispatchQueuedException('queued-1');
        unawaited(dispatchDeploy());
        async.flushMicrotasks();
        async.elapse(kRemotePipelineDispatchTimeout);
        expect(deployDispatch(), isA<RemotePipelineDispatchSubmitting>());
        unawaited(dispatchDeploy());
        async.flushMicrotasks();
        expect(repository.pipelineDispatches, hasLength(1));
        commands.handleCompleted('queued-1', {
          'executionId': 'exec-queued',
        }, projectionSequence: 0);
        expect(
          (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
          'exec-queued',
        );
      });
    });

    test('a queued send can settle from its matching run update', () async {
      repository.pipelineDispatchError =
          const RemotePipelineDispatchQueuedException('queued-1');
      await dispatchDeploy();
      expect(
        dispatcher.observeRunStarted(
          commandId: 'queued-1',
          executionId: 'exec-queued',
        ),
        isTrue,
      );
      expect(deployDispatch(), isA<RemotePipelineDispatchStarted>());
    });

    group('a late answer from an earlier attempt', () {
      /// Attempt 1's send hangs until the watchdog fails it; the user then
      /// retries, so attempt 2 is in flight while attempt 1 can still answer.
      ({Completer<String> first, Completer<String> second}) retryAfterWatchdog(
        FakeAsync async,
      ) {
        dispatcher.dispose();
        dispatcher = build();
        final first = Completer<String>();
        final second = Completer<String>();
        repository.pipelineDispatchGate = first;
        unawaited(dispatchDeploy());
        async.flushMicrotasks();
        async.elapse(kRemotePipelineDispatchTimeout);
        expect(
          (deployDispatch()! as RemotePipelineDispatchFailed).message,
          kRemotePipelineDispatchUnconfirmed,
        );
        repository.pipelineDispatchGate = second;
        unawaited(dispatchDeploy());
        async.flushMicrotasks();
        expect(deployDispatch(), isA<RemotePipelineDispatchSubmitting>());
        return (first: first, second: second);
      }

      test('a late command id is not adopted by the retry', () {
        fakeAsync((async) {
          final gates = retryAfterWatchdog(async);
          final retry = deployDispatch();

          gates.first.complete('late-1');
          async.flushMicrotasks();
          expect(deployDispatch(), same(retry));
          // The old id was never registered, so its terminal is foreign.
          commands.handleCompleted('late-1', {
            'executionId': 'late-exec',
          }, projectionSequence: 0);
          expect(deployDispatch(), same(retry));

          gates.second.complete('pipeline-run-2');
          async.flushMicrotasks();
          commands.handleCompleted('pipeline-run-2', {
            'executionId': 'exec-2',
          }, projectionSequence: 0);
          expect(
            (deployDispatch()! as RemotePipelineDispatchStarted).executionId,
            'exec-2',
          );
        });
      });

      test('a late failure leaves the retry and its watchdog alone', () {
        fakeAsync((async) {
          final gates = retryAfterWatchdog(async);
          final retry = deployDispatch();

          gates.first.completeError(Exception('late'));
          async.flushMicrotasks();
          expect(deployDispatch(), same(retry));

          // The retry's own watchdog is still armed.
          async.elapse(kRemotePipelineDispatchTimeout);
          expect(
            (deployDispatch()! as RemotePipelineDispatchFailed).message,
            kRemotePipelineDispatchUnconfirmed,
          );
          gates.second.complete('unused');
          async.flushMicrotasks();
        });
      });

      test('an earlier command terminal cannot settle the retry', () {
        fakeAsync((async) {
          dispatcher.dispose();
          dispatcher = build();
          unawaited(dispatchDeploy());
          async.flushMicrotasks();
          // Attempt 1 registered pipeline-run-1; its watchdog then fires.
          async.elapse(kRemotePipelineDispatchTimeout);
          final gate = Completer<String>();
          repository.pipelineDispatchGate = gate;
          unawaited(dispatchDeploy());
          async.flushMicrotasks();
          final retry = deployDispatch();

          commands.handleCompleted('pipeline-run-1', {
            'executionId': 'exec-old',
          }, projectionSequence: 0);
          expect(deployDispatch(), same(retry));
          expect(
            dispatcher.observeRunStarted(
              commandId: 'pipeline-run-1',
              executionId: 'exec-old',
            ),
            isFalse,
          );
          expect(deployDispatch(), same(retry));
          gate.complete('pipeline-run-2');
          async.flushMicrotasks();
        });
      });
    });

    test('a reset mid-flight drops the late completion', () async {
      final gate = Completer<String>();
      repository.pipelineDispatchGate = gate;
      final inFlight = dispatchDeploy();
      dispatcher.reset();
      gate.complete('pipeline-run-1');
      await inFlight;
      commands.handleCompleted('pipeline-run-1', {
        'executionId': 'stale',
      }, projectionSequence: 0);
      expect(deployDispatch(), isNull);
    });

    test('disconnected fails immediately without sending', () async {
      connected = false;
      await dispatchDeploy();
      expect(
        (deployDispatch()! as RemotePipelineDispatchFailed).message,
        'Not connected to a desktop.',
      );
      expect(repository.pipelineDispatches, isEmpty);
    });

    test('clearDispatch forgets the outcome', () async {
      await dispatchDeploy();
      commands.handleCompleted('pipeline-run-1', null, projectionSequence: 0);
      dispatcher.clearDispatch(worktreeLocalId: 'wt', pipelineId: 'deploy');
      expect(deployDispatch(), isNull);
    });
  });
}
