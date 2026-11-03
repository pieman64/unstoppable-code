// CAN-3372 capture spec: visual evidence only, not regression coverage. The
// durable coverage is the `flutter test` suite (portal_event_stream_test,
// portal_sse_parser_test, portal_event_decoder_test,
// http_remote_control_repository_test) and the on-device
// portal_event_decode_device_test.
//
// CAN-3372 changes how large Portal event frames are parsed and decoded, not
// what the chat shows: the Remote chat must look exactly as before when a
// 300-message snapshot arrives. For SSE and long-poll in the light and then
// the dark theme, this captures the open chat before the snapshot, the loaded
// transcript, and the next small streaming update. Run once per stage on the
// unchanged and changed trees from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3372_portal_event_capture_test.dart \
//     --dart-define=CAN3372_STAGE=before -d <device-id>
//
// Deterministic: bytes go through the real `PortalEventStream` from a
// synthetic client into the local fake repository (no pairing, desktop or
// network), every row and timestamp is fixed, and the theme mode is forced.
// Captures land in
// build/promo_screenshots/can3372-<stage>-<theme>-<transport>-<state>.png.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';
import '../test/support/portal_event_workloads.dart';
import '../test/support/portal_transport_driver.dart';

const _stage = String.fromEnvironment('CAN3372_STAGE', defaultValue: 'after');

RemoteSessionSnapshot _shell() => RemoteSessionSnapshot(
  workspaces: const [],
  standaloneChats: const [],
  worktrees: const [
    RemoteWorktree(
      localId: workloadWorktreeId,
      workspaceLocalId: workloadWorkspaceId,
      branch: 'main',
    ),
  ],
  chatSummaries: const [
    RemoteChatSummary(
      chatId: workloadChatId,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: workloadWorkspaceId,
      worktreeLocalId: workloadWorktreeId,
      title: 'Benchmark chat',
      active: true,
    ),
  ],
);

/// The chat shows a progress indicator until its transcript arrives, so it
/// never settles; pump a bounded run of frames instead.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('captures a large snapshot arriving', (tester) async {
    await binding.convertFlutterSurfaceToImage();
    for (final theme in ['light', 'dark']) {
      for (final transport in ['sse', 'longpoll']) {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = _shell;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await viewModel.connect('123456');
        final driver = PortalTransportDriver(repository);
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<RemoteControlViewModel>.value(
                value: viewModel,
              ),
              ChangeNotifierProvider<TurnFeedbackController>(
                create: (_) => TurnFeedbackController(
                  repository: MockTurnFeedbackRepository(),
                ),
              ),
            ],
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              themeMode: theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
              home: RemoteChatScreen.worktree(
                worktree: viewModel.worktreesFor(workloadWorkspaceId).single,
              ),
            ),
          ),
        );
        await _settle(tester);

        Future<void> capture(String state) async {
          await tester.pump(const Duration(milliseconds: 500));
          await binding.takeScreenshot(
            'can3372-$_stage-$theme-$transport-$state',
          );
        }

        await capture('01-before-snapshot');
        final snapshot = portalDeviceSnapshot('snapshot600KiB', 100);
        if (transport == 'sse') {
          await driver.sse(
            sseFrame(snapshot),
            untilCursor: 100,
            chunkBytes: 16 * 1024,
          );
        } else {
          await driver.longPoll(snapshot);
        }
        await _settle(tester);
        await capture('02-snapshot-loaded');

        await driver.sse(
          sseFrame(
            streamingMessageBatchJson(
              nextCursor: 101,
              text: 'Streaming the next answer after the snapshot.',
            ),
          ),
          untilCursor: 101,
        );
        await _settle(tester);
        await capture('03-streaming-update');
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
      }
    }
  });
}
