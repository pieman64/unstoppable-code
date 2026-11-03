// CAN-4533: the platform picker's copies are recorded for the worktree they
// were picked in, so archiving it reclaims them. A new task's copies read
// before its worktree exists wait for it; an existing worktree's are
// recorded as they are read.
//
// This file holds one test on purpose: `AttachmentCache` serializes its
// operations on a static queue, and a queue entry left by an earlier test's
// fake-async zone never completes in a later one.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:path/path.dart' as p;
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/composer_driver.dart';
import '../../../support/fake_remote_control_repository.dart';

const _workspace = RemoteWorkspace(
  localId: 'ws-app',
  order: 0,
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
);

const _existing = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-app',
  branch: 'feature/oauth',
);

const _created = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-app',
  branch: 'canopy/otter',
);

void main() {
  testWidgets('CAN-4533 camera copies are reclaimed with the worktree they '
      'were picked in', (tester) async {
    // 390 logical pixels wide, as on a phone.
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});
    final cacheDir = (await tester.runAsync(
      () => Directory.systemTemp.createTemp('can-4533-picker-copies-'),
    ))!;
    addTearDown(() => cacheDir.delete(recursive: true));
    final copies = <String>[];
    for (final name in ['before.png', 'after.png', 'existing.png']) {
      final copy = File(p.join(cacheDir.path, name));
      await tester.runAsync(() => copy.writeAsBytes([1, 2, 3]));
      copies.add(copy.path);
    }
    // The platform channel the image picker uses on a device.
    const channel = MethodChannel('plugins.flutter.io/image_picker');
    final pending = List.of(copies);
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => call.method == 'pickImage' ? pending.removeAt(0) : null,
    );
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    final createResult = Completer<RemoteWorktreeCreateResult>();
    final worktrees = <RemoteWorktree>[_existing];
    final repository = FakeRemoteControlRepository()
      ..supportsChatAttachments = true
      ..createWorktreeHandler = (() => createResult.future)
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [_workspace],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
    final cache = AttachmentCache(temporaryDirectories: () async => [cacheDir]);
    final viewModel = RemoteControlViewModel(
      repository: repository,
      attachmentCache: cache,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: Duration.zero,
    );
    await tester.runAsync(() => viewModel.connect('123456'));
    Widget app(Widget home) => MultiProvider(
      providers: [
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
        ChangeNotifierProvider<TurnFeedbackController>(
          create: (_) =>
              TurnFeedbackController(repository: MockTurnFeedbackRepository()),
        ),
      ],
      child: MaterialApp(theme: AppTheme.light, home: home),
    );

    /// The desktop lists [chatId] as the active tab of [worktree].
    void projectChat(RemoteWorktree worktree, String chatId, int cursor) {
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateDeltaEvent(
              chatSummaries: [
                RemoteChatSummary(
                  chatId: chatId,
                  scope: RemoteChatScope.worktree,
                  workspaceLocalId: worktree.workspaceLocalId,
                  worktreeLocalId: worktree.localId,
                  title: 'New chat',
                  active: true,
                ),
              ],
            ),
          ],
          nextCursor: cursor,
        ),
      );
    }

    await tester.pumpWidget(
      app(const RemoteChatScreen.create(workspace: _workspace)),
    );
    await tester.pump();
    await tester.pump();

    // File reads finish on the real event loop, and what awaits them in
    // frames: alternate the two.
    Future<void> runIo({Future<void>? until}) async {
      var done = false;
      unawaited(until?.whenComplete(() => done = true));
      for (var i = 0; i < 40 && !done; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump(const Duration(milliseconds: 50));
      }
      if (until != null) expect(done, isTrue);
    }

    Future<void> takePhoto() async {
      await openComposerActions(tester);
      await tester.tap(
        find.byKey(const ValueKey('composer-action-attach-camera')),
      );
      await runIo();
    }

    // The first photo is read while the worktree is created.
    expect(find.text('Creating worktree…'), findsOneWidget);
    await takePhoto();
    expect(repository.uploadCalls, isEmpty);

    // The desktop creates the worktree and lists its first chat.
    worktrees.add(_created);
    createResult.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    projectChat(_created, 'chat-a', 10);
    await runIo();
    await takePhoto();
    expect(repository.uploadCalls.map((call) => call.filename), [
      'before.png',
      'after.png',
    ]);

    Future<List<String>?> remaining() => tester.runAsync(
      () async => [
        for (final copy in copies)
          if (await File(copy).exists()) p.basename(copy),
      ],
    );

    // Archiving the new worktree reclaims both of its copies.
    await runIo(until: cache.clear('ws-app', 'wt-2'));
    expect(await remaining(), ['existing.png']);
    expect(tester.takeException(), isNull);

    // An existing worktree's copy is recorded for it as it is read, on a
    // screen of its own.
    await tester.pumpWidget(
      app(
        const RemoteChatScreen.worktree(
          key: ValueKey('existing'),
          worktree: _existing,
        ),
      ),
    );
    projectChat(_existing, 'chat-e', 20);
    await runIo();
    await takePhoto();
    expect(repository.uploadCalls.last.filename, 'existing.png');
    await runIo(until: cache.clear('ws-app', 'wt-1'));
    expect(await remaining(), isEmpty);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    // Flush hydration watchdogs the bound worktree may have started.
    await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    viewModel.dispose();
    await repository.eventsController.close();
  }, timeout: const Timeout(Duration(seconds: 60)));
}
