// CAN-3373 — device verification that a recently viewed Remote Control chat
// paints its persisted tail on the first frame after a cold start, and that
// the server's tail and the desktop's snapshot then replace it without
// duplicates or gaps. Uses the production storage: application support
// storage resolved by the host adapter, encoded on a worker isolate.
//
// Real process death takes two runs from apps/mobile; the second must keep
// the app's data (no uninstall or data clear in between):
//
//   flutter drive --no-pub --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3373_transcript_cache_device_test.dart \
//     --dart-define=CAN3373_PHASE=seed --keep-app-running -d <device-id>
//   adb -s <device-id> shell am force-stop com.unstoppabledomains.canopy
//   flutter drive ... --dart-define=CAN3373_PHASE=reopen -d <device-id>
//
// Without a phase both run in one process with fresh storage and view
// models: durable coverage of the flow, but not proof of a cold process.
// The repository is the synthetic fixture: no pairing, desktop, or network.
// Each phase reports its process id and timings in the response data.

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/remote_transcript_cache_fixture.dart';

const _phase = String.fromEnvironment('CAN3373_PHASE', defaultValue: 'both');

/// Source transcript sizes: a short chat, and one longer than the 50
/// messages kept.
const _sizes = {Can3373Chat.worktree: 10, Can3373Chat.standalone: 300};

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final report = <String, Object?>{'phase': _phase};

  RemoteControlViewModel launch(Can3373Repository repository) =>
      RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        transcriptCache: RemoteTranscriptCache(
          storage: FileRemoteTranscriptStorage(
            directory: remoteTranscriptCacheDirectory,
          ),
          accountScope: kCan3373AccountScope,
        ),
      );

  Future<Map<String, Object?>> stored() async {
    final directory = await remoteTranscriptCacheDirectory();
    final files = [
      for (final entity in directory.listSync())
        if (entity is File) entity,
    ]..sort((a, b) => a.path.compareTo(b.path));
    return {
      'directory': directory.path,
      'files': files.length,
      'bytes': files.fold<int>(0, (sum, file) => sum + file.lengthSync()),
      'sha256': [
        for (final file in files)
          sha256.convert(file.readAsBytesSync()).toString(),
      ],
    };
  }

  Future<void> seed(WidgetTester tester) async {
    await FileRemoteTranscriptStorage(
      directory: remoteTranscriptCacheDirectory,
    ).clear();
    final repository = Can3373Repository();
    final vm = launch(repository);
    await vm.connect('123456');
    var cursor = 1;
    for (final MapEntry(key: chat, value: size) in _sizes.entries) {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(can3373ChatHost(vm, chat));
      await tester.pump();
      repository
        ..releaseServerTail(chat, const [])
        ..deliverSnapshot(chat, can3373Rows(chat, 0, size), cursor: cursor++);
      await tester.pump(const Duration(milliseconds: 300));
      expect(vm.messagesFor(chat.target), hasLength(size));
    }
    // Leaving the app writes what is pending at once.
    vm.onAppBackgrounded();
    await vm.transcriptCache!.flush();
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
    final files = await stored();
    expect(files['files'], _sizes.length);
    report['seed'] = {'pid': pid, ...files};
  }

  Future<void> reopen(WidgetTester tester) async {
    report['reopenStored'] = await stored();
    final repository = Can3373Repository();
    final vm = launch(repository);
    final launchClock = Stopwatch()..start();
    await vm.connect('123456');
    final connectMs = launchClock.elapsedMicroseconds / 1000;
    // Usually already loaded: connect waits for it within a budget. Waiting
    // here keeps a slow first isolate from failing the first-frame check,
    // and the report shows whether the budget was enough.
    await vm.transcriptCache!.restoreSession(kCan3373SessionId);
    final timings = <String, Object?>{
      'pid': pid,
      'connectMs': connectMs,
      'warmMs': launchClock.elapsedMicroseconds / 1000,
    };
    var cursor = 1;
    for (final MapEntry(key: chat, value: size) in _sizes.entries) {
      await tester.pumpWidget(const SizedBox.shrink());
      final open = Stopwatch()..start();
      await tester.pumpWidget(can3373ChatHost(vm, chat));
      timings['${chat.name}FirstFrameMs'] = open.elapsedMicroseconds / 1000;

      // First frame: the newest persisted message, no loading state, and
      // the transcript request still out.
      final kept = size < kRemoteTranscriptCacheMaxMessages
          ? size
          : kRemoteTranscriptCacheMaxMessages;
      expect(find.text(can3373Row(chat, size - 1).text), findsOneWidget);
      expect(find.text('Loading conversation…'), findsNothing);
      expect(vm.messagesFor(chat.target), hasLength(kept));
      expect(vm.isChatTranscriptLoading(chat.target), isFalse);

      // The server tail replaces it, then the desktop's bounded snapshot.
      repository.releaseServerTail(chat, can3373Rows(chat, size - 8, size + 1));
      await tester.pump(const Duration(milliseconds: 300));
      repository.deliverSnapshot(
        chat,
        can3373Rows(chat, size - 4, size + 2),
        cursor: cursor++,
        truncated: true,
      );
      await tester.pump(const Duration(milliseconds: 300));
      final ids = [
        for (final row in vm.messagesFor(chat.target)) row.messageId,
      ];
      expect(ids, [
        for (final row in can3373Rows(chat, size - 4, size + 2)) row.messageId,
      ]);
      expect(find.text(can3373Row(chat, size + 1).text), findsOneWidget);
    }
    report['reopen'] = timings;
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  }

  tearDownAll(() {
    binding.reportData = {'can3373': report};
    // ignore: avoid_print
    print('CAN3373_REPORT ${jsonEncode(report)}');
  });

  testWidgets('CAN-3373 persisted chat tails across a cold start ($_phase)', (
    tester,
  ) async {
    if (_phase != 'reopen') await seed(tester);
    if (_phase != 'seed') await reopen(tester);
  });
}
