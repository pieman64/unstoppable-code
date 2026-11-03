// On-device correctness for large Portal event frames (CAN-3372). Bytes go
// through the real `PortalEventStream`, whose batches feed the real view
// model and an open Remote chat screen. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/portal_event_decode_device_test.dart \
//     -d <device-id>
//
// Covers a 300-message snapshot over SSE (1 KiB and 16 KiB chunks) and
// long-poll, the next small streaming update after it, a malformed large
// frame followed by a valid one, and a subscription cancelled while a large
// frame decodes: no late batch may arrive, and a replacement subscription
// still delivers. Synthetic data only; no pairing, desktop or network.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
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

const _target = RemoteWorktreeChatTarget(
  workspaceLocalId: workloadWorkspaceId,
  worktreeLocalId: workloadWorktreeId,
  chatId: workloadChatId,
);

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
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late FakeRemoteControlRepository repository;
  late RemoteControlViewModel viewModel;
  late PortalTransportDriver driver;

  Future<void> openChat(WidgetTester tester) async {
    repository = FakeRemoteControlRepository()..snapshotBuilder = _shell;
    viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    driver = PortalTransportDriver(repository);
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
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: RemoteChatScreen.worktree(
            worktree: viewModel.worktreesFor(workloadWorkspaceId).single,
          ),
        ),
      ),
    );
    await _settle(tester);
  }

  Future<void> closeChat(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    viewModel.dispose();
  }

  void expectSnapshotRows() {
    final rows = viewModel.messagesFor(_target);
    expect(rows.length, greaterThanOrEqualTo(300));
    final ids = rows.map((row) => row.messageId).toSet();
    expect(ids, containsAll(['msg-0', 'msg-150', 'msg-299']));
    expect(
      rows.firstWhere((row) => row.messageId == 'msg-3').text,
      contains('café ✓'),
    );
  }

  for (final chunk in [1024, 16 * 1024]) {
    testWidgets('SSE snapshot in ${chunk ~/ 1024} KiB chunks, then an update', (
      tester,
    ) async {
      await openChat(tester);
      final snapshot = portalDeviceSnapshot('snapshot600KiB', 100);
      final delivery = await driver.sse(
        sseFrame(snapshot) +
            sseFrame(
              streamingMessageBatchJson(nextCursor: 101, text: 'After it'),
            ),
        untilCursor: 101,
        chunkBytes: chunk,
      );
      await _settle(tester);

      expect(delivery.batches.map((batch) => batch.nextCursor), [100, 101]);
      expectSnapshotRows();
      expect(
        viewModel
            .messagesFor(_target)
            .firstWhere((row) => row.messageId == 'msg-live')
            .text,
        'After it',
      );
      expect(tester.takeException(), isNull);
      await closeChat(tester);
    });
  }

  testWidgets('long-poll snapshot', (tester) async {
    await openChat(tester);
    final delivery = await driver.longPoll(
      portalDeviceSnapshot('snapshotNearCap', 100),
    );
    await _settle(tester);

    expect(delivery.batches.single.nextCursor, 100);
    expectSnapshotRows();
    expect(tester.takeException(), isNull);
    await closeChat(tester);
  });

  testWidgets('a malformed large frame is skipped', (tester) async {
    await openChat(tester);
    final snapshot = portalDeviceSnapshot('snapshot600KiB', 100);
    final delivery = await driver.sse(
      sseFrame(snapshot.substring(0, snapshot.length - 1)) +
          sseFrame(streamingMessageBatchJson(nextCursor: 101)),
      untilCursor: 101,
      chunkBytes: 16 * 1024,
    );
    await _settle(tester);

    expect(delivery.batches.map((batch) => batch.nextCursor), [101]);
    expect(tester.takeException(), isNull);
    await closeChat(tester);
  });

  testWidgets('cancelling mid-decode drops the late batch', (tester) async {
    await openChat(tester);
    final late = await driver.cancelDuringDecode(
      sseFrame(portalDeviceSnapshot('snapshotNearCap', 100)),
    );
    expect(late, isEmpty);

    // A replacement subscription still delivers.
    final delivery = await driver.sse(
      sseFrame(portalDeviceSnapshot('snapshot600KiB', 200)),
      untilCursor: 200,
      chunkBytes: 16 * 1024,
    );
    await _settle(tester);
    expect(
      delivery.batches.single.events.first,
      isA<RemoteStateSnapshotEvent>(),
    );
    expectSnapshotRows();
    expect(tester.takeException(), isNull);
    await closeChat(tester);
  });
}
