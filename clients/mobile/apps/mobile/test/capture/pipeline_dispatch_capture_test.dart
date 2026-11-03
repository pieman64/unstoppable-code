// Pipeline dispatch visual evidence (CAN-3174). Run from apps/mobile:
// PIPELINE_DISPATCH_STAGE=before|after flutter test test/capture/pipeline_dispatch_capture_test.dart --update-goldens
// Fixed local fixtures and bundled fonts; no desktop, agents, or network.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../support/fake_remote_control_repository.dart';

void main() {
  final stage = Platform.environment['PIPELINE_DISPATCH_STAGE'];
  for (final dark in [false, true]) {
    testWidgets('pipeline dispatch ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 760);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await (FontLoader('Inter')
            ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf')))
          .load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      const snapshot = RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/dispatch',
          ),
        ],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Ship the release',
            active: true,
          ),
        ],
        chatMessages: [],
      );
      final repository = FakeRemoteControlRepository()
        ..supportsPipelineDispatch = stage != 'before'
        ..worktreeStateSlices = {
          'wt-1': {
            'pipelines': [
              {
                'pipelineId': 'deploy',
                'name': 'Deploy',
                'description': 'Ship the branch to an environment.',
                'origin': 'project',
                'triggerTypes': ['dispatch'],
                'worktreeLocalId': 'wt-1',
              },
              {
                'pipelineId': 'review',
                'name': 'Code review',
                'description': 'Review the diff with an agent.',
                'origin': 'bundled',
                'triggerTypes': ['dispatch'],
                'worktreeLocalId': 'wt-1',
              },
            ],
          },
        }
        ..pipelineFormResult = {
          'dispatchInputs': {
            'environment': {
              'type': 'choice',
              'required': true,
              'options': ['staging', 'production'],
              'description': 'Where to deploy',
            },
            'replicas': {'type': 'number', 'min': 1, 'max': 5, 'default': 2},
            'dry_run': {'type': 'boolean', 'default': true},
            'note': {'type': 'string', 'description': 'Release note'},
          },
        };
      repository.snapshotBuilder = () => snapshot;
      final gate = Completer<String>();
      repository.pipelineDispatchGate = gate;
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: vm),
            ChangeNotifierProvider(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            navigatorObservers: [appRouteObserver],
            home: RemoteChatScreen.worktree(
              worktree: vm.worktreesFor('ws-1').single,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> capture(String name) async {
        if (stage == null) return;
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            '../../../../.playwright/can-3174/$name-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
      }

      // Settle any in-flight dispatch and tear the tree down so the
      // dispatcher's watchdog timer does not outlive the test.
      Future<void> finish() async {
        if (!gate.isCompleted) gate.complete('');
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      }

      try {
        await tester.tap(find.byKey(const ValueKey('open-activity')));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Pipeline Runs'),
          200,
          scrollable: find.byType(Scrollable).last,
        );
        await capture('sidebar-card');
        if (stage == 'before') return;

        await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-open')));
        await tester.pumpAndSettle();
        await capture('picker');

        await tester.tap(
          find.byKey(const ValueKey('pipeline-picker-row:deploy')),
        );
        await tester.pumpAndSettle();
        await capture('form');

        await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
        await tester.pumpAndSettle();
        await capture('validation');

        await tester.tap(
          find.byKey(const ValueKey('pipeline-dispatch-field:environment')),
        );
        await tester.pumpAndSettle();
        await capture('choice-sheet');
        await tester.tap(
          find.byKey(
            const ValueKey('pipeline-dispatch-choice:environment:staging'),
          ),
        );
        await tester.pumpAndSettle();

        // Reopen the sheet to capture the checkmark on the selected row.
        await tester.tap(
          find.byKey(const ValueKey('pipeline-dispatch-field:environment')),
        );
        await tester.pumpAndSettle();
        await capture('choice-sheet-selected');
        await tester.tap(
          find.byKey(
            const ValueKey('pipeline-dispatch-choice:environment:staging'),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-run')));
        await tester.pump();
        await capture('pending');
        gate.complete('');
        await tester.pumpAndSettle();
        await capture('unconfirmed');
      } finally {
        await finish();
      }
    });
  }
}
