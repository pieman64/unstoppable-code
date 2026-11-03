// CAN-3719 — durable device flow for the pipeline run screen's Chat
// follow-up. Run from apps/mobile on an Android emulator or iOS simulator:
//
//   flutter test integration_test/can_3719_pipeline_follow_up_test.dart \
//     -d <device-id>
//
// The production run, chat and theme code runs on the synthetic paired
// session in test/support/pipeline_follow_up_fixture.dart: no desktop,
// account or network. Real transport is covered by
// can_3719_pipeline_follow_up_paired_test.dart.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_chat_follow_up_coordinator.dart'
    show kRemotePipelineFollowUpTimeout;
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_run_chat_follow_up.dart'
    show kPipelineRunFollowUpNoOutput;
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';
import '../test/support/pipeline_follow_up_fixture.dart';

const _ownerDraft = RemoteWorktreeChatDraftTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-owner',
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late PipelineFollowUpFixtureRepository repository;
  late InMemoryChatDraftStore drafts;
  late RemoteControlViewModel vm;

  Finder button() => find.byKey(const ValueKey('pipeline-run-chat-follow-up'));

  /// Pumps frames until [finder] matches, failing after [timeout].
  Future<void> pumpUntil(
    WidgetTester tester,
    Finder finder, {
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final end = DateTime.now().add(timeout);
    while (finder.evaluate().isEmpty) {
      if (DateTime.now().isAfter(end)) {
        fail('Timed out waiting for $finder');
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  /// Pumps real frames for [milliseconds] so transitions finish.
  Future<void> settle(WidgetTester tester, [int milliseconds = 600]) async {
    final end = DateTime.now().add(Duration(milliseconds: milliseconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  Future<void> open(
    WidgetTester tester, {
    Map<String, dynamic>? payload,
    String routeWorktreeLocalId = 'wt-1',
  }) async {
    vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      draftStore: drafts,
    );
    await vm.connect('123456');
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: ChatDraftStoreHolder(drafts),
        child: ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            home: RemotePipelineRunScreen(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: routeWorktreeLocalId,
              executionId: followUpExecutionId,
              pipelineName: 'Plan and review',
            ),
          ),
        ),
      ),
    );
    await settle(tester, 200);
    repository.eventsController.add(
      followUpRunEvent(payload ?? followUpRunPayload()),
    );
    await pumpUntil(tester, find.text('Draft plan'));
    await settle(tester);
  }

  Future<void> close(WidgetTester tester) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await settle(tester, 200);
    vm.dispose();
  }

  setUp(() {
    repository = PipelineFollowUpFixtureRepository()
      ..followUpChatId = 'chat-owner';
    drafts = InMemoryChatDraftStore();
  });

  testWidgets(
    'a report-only run sends once to its owner, keeps the draft and Back '
    'restores the selected step',
    (tester) async {
      drafts.setDraft(_ownerDraft, 'my unsent thought');
      await open(
        tester,
        routeWorktreeLocalId: 'wt-2',
        payload: followUpRunPayload(
          status: 'failed',
          chatFollowUp: {'planAvailable': false, 'reportAvailable': true},
        ),
      );
      await tester.tap(find.text('Draft plan'));
      await pumpUntil(tester, find.byKey(const ValueKey('pipeline-run-log')));

      await tester.tap(button());
      await pumpUntil(tester, find.byType(RemoteChatScreen));
      await pumpUntil(
        tester,
        find.text('Review this report: /runs/exec-1/report.md'),
      );

      final prepare = repository.followUpPrepareCalls.single;
      expect(prepare.worktreeLocalId, 'wt-1');
      expect(prepare.output, RemotePipelineFollowUpOutput.report);
      final send = repository.sendChatMessageCalls.single;
      expect(send.text, 'Review this report: /runs/exec-1/report.md');
      expect(
        send.target,
        isA<RemoteWorktreeChatTarget>()
            .having((t) => t.worktreeLocalId, 'worktree', 'wt-1')
            .having((t) => t.chatId, 'chat', 'chat-owner'),
      );
      expect(drafts.draftFor(_ownerDraft), 'my unsent thought');

      // Let the push transition finish before using the chat's Back button.
      await settle(tester, 1200);
      await tester.pageBack();
      await settle(tester);
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(find.byKey(const ValueKey('pipeline-run-log')), findsOneWidget);
      expect(find.text('Saved the plan for invoice rounding.\n'), findsWidgets);
      expect(repository.sendChatMessageCalls, hasLength(1));
      await close(tester);
    },
  );

  testWidgets('both outputs offer a choice; closing it sends nothing', (
    tester,
  ) async {
    await open(tester);

    await tester.tap(button());
    await pumpUntil(tester, find.text('Review report'));
    await settle(tester);
    expect(find.text('Review plan'), findsOneWidget);
    await tester.tapAt(const Offset(20, 80));
    await settle(tester);
    expect(find.text('Review plan'), findsNothing);
    expect(repository.followUpPrepareCalls, isEmpty);
    expect(repository.sendChatMessageCalls, isEmpty);

    await tester.tap(button());
    await pumpUntil(tester, find.text('Review plan'));
    await settle(tester);
    await tester.tap(find.text('Review plan'));
    await pumpUntil(tester, find.byType(RemoteChatScreen));
    expect(repository.followUpPrepareCalls.single.output.name, 'plan');
    expect(
      repository.sendChatMessageCalls.single.text,
      'Review this plan: /plans/invoice-rounding.md',
    );
    await close(tester);
  });

  testWidgets('repeated taps while pending send one message', (tester) async {
    final answer = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => answer.future;
    await open(
      tester,
      payload: followUpRunPayload(
        chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
      ),
    );

    await tester.tap(button());
    await settle(tester, 300);
    await tester.tap(button(), warnIfMissed: false);
    await tester.tap(button(), warnIfMissed: false);
    await settle(tester, 300);
    expect(repository.followUpPrepareCalls, hasLength(1));

    answer.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: followUpExecutionId,
          output: RemotePipelineFollowUpOutput.plan,
          chatId: 'chat-owner',
        ),
      ),
    );
    await pumpUntil(tester, find.byType(RemoteChatScreen));
    await settle(tester);
    expect(repository.followUpPrepareCalls, hasLength(1));
    expect(repository.sendChatMessageCalls, hasLength(1));
    await close(tester);
  });

  testWidgets(
    'a plan-only run with no writable chat creates one and sends once',
    (tester) async {
      repository.followUpChatId = null;
      await open(
        tester,
        payload: followUpRunPayload(
          chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
        ),
      );

      await tester.tap(button());
      await pumpUntil(tester, find.byType(RemoteChatScreen));
      await pumpUntil(
        tester,
        find.text('Review this plan: /plans/invoice-rounding.md'),
      );

      expect(repository.followUpPrepareCalls.single.output.name, 'plan');
      final created = repository.createChatTabTargets.single;
      expect(created.worktreeLocalId, 'wt-1');
      final send = repository.sendChatMessageCalls.single;
      expect(send.text, 'Review this plan: /plans/invoice-rounding.md');
      expect(
        send.target,
        isA<RemoteWorktreeChatTarget>().having(
          (t) => t.chatId,
          'chat',
          created.chatId,
        ),
      );
      // Normal scoped defaults: the follow-up picks no provider or model.
      expect(send.options?.model, isNull);
      await settle(tester);
      await close(tester);
    },
  );

  testWidgets('a stalled preparation times out and sends nothing', (
    tester,
  ) async {
    final stalled = Completer<RemotePortalCommandResult>();
    repository.followUpPrepareHandler = () => stalled.future;
    await open(
      tester,
      payload: followUpRunPayload(
        chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
      ),
    );

    await tester.tap(button());
    await pumpUntil(
      tester,
      find.text("Your desktop didn't answer. Nothing was sent. Try again."),
      timeout: kRemotePipelineFollowUpTimeout + const Duration(seconds: 10),
    );
    stalled.complete(
      RemotePortalCommandResult(
        commandId: 'prep-1',
        result: followUpPreparationJson(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: followUpExecutionId,
          output: RemotePipelineFollowUpOutput.plan,
          chatId: 'chat-owner',
        ),
      ),
    );
    await settle(tester);
    expect(find.byType(RemoteChatScreen), findsNothing);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.widget<CanopyButton>(button()).onPressed, isNotNull);
    await close(tester);
  });

  testWidgets('a host rejection shows its reason and sends nothing', (
    tester,
  ) async {
    repository.followUpPrepareHandler = () async =>
        throw const RemoteControlException(
          'This pipeline run does not have a saved plan file.',
        );
    await open(
      tester,
      payload: followUpRunPayload(
        chatFollowUp: {'planAvailable': true, 'reportAvailable': false},
      ),
    );

    await tester.tap(button());
    await pumpUntil(
      tester,
      find.text('This pipeline run does not have a saved plan file.'),
    );
    expect(find.byType(RemoteChatScreen), findsNothing);
    expect(repository.sendChatMessageCalls, isEmpty);
    await close(tester);
  });

  testWidgets('a run without saved output explains why and sends nothing', (
    tester,
  ) async {
    await open(
      tester,
      payload: followUpRunPayload(
        chatFollowUp: {'planAvailable': false, 'reportAvailable': false},
      ),
    );

    expect(button(), findsNothing);
    expect(find.text(kPipelineRunFollowUpNoOutput), findsOneWidget);
    expect(find.text(kRemotePipelineFollowUpUnsupported), findsNothing);
    expect(repository.sendChatMessageCalls, isEmpty);
    await close(tester);
  });

  testWidgets('an older desktop gets an update hint instead of the button', (
    tester,
  ) async {
    repository.supportsPipelineChatFollowUp = false;
    await open(tester, payload: followUpRunPayload(chatFollowUp: null));

    expect(button(), findsNothing);
    expect(find.text(kRemotePipelineFollowUpUnsupported), findsOneWidget);
    await close(tester);
  });
}
