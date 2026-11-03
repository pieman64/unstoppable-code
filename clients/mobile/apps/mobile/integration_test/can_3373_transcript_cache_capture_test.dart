// CAN-3373 capture harness — not regression coverage (that is
// can_3373_transcript_cache_device_test.dart). Captures reopening a recently
// viewed chat while the server cache and the desktop have not answered yet,
// then the server tail and the desktop's snapshot replacing what it showed.
// Run from apps/mobile, light and dark in each run:
//
//   flutter drive --no-pub --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3373_transcript_cache_capture_test.dart \
//     --dart-define=CAN3373_STAGE=after -d <device-id>
//
// `before` opens the chat without a transcript cache, which is how every
// reopen behaved before CAN-3373; `after` opens it over a persisted tail.
// Screenshots land in build/promo_screenshots as
// can3373-<stage>-<theme>-<step>.png. Synthetic data only.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/remote_transcript_cache_fixture.dart';

const _stage = String.fromEnvironment('CAN3373_STAGE', defaultValue: 'after');
const _chat = Can3373Chat.standalone;
const _size = 120;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('captures a cold reopen ($_stage)', (tester) async {
    await binding.convertFlutterSurfaceToImage();
    for (final theme in ['light', 'dark']) {
      final storage = FileRemoteTranscriptStorage(
        directory: remoteTranscriptCacheDirectory,
      );
      await storage.clear();
      if (_stage == 'after') {
        storage.write(
          (accountScope: kCan3373AccountScope, sessionId: kCan3373SessionId),
          PersistedTranscript(
            chat: (scope: _chat.scope, chatId: _chat.chatId),
            openedAt: 1,
            rows: can3373Rows(_chat, _size - 50, _size),
          ),
        );
        await storage.flush();
      }
      final repository = Can3373Repository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        transcriptCache: _stage == 'after'
            ? RemoteTranscriptCache(
                storage: storage,
                accountScope: kCan3373AccountScope,
              )
            : null,
      );
      await vm.connect('123456');
      await vm.transcriptCache?.restoreSession(kCan3373SessionId);

      Future<void> capture(String step) =>
          binding.takeScreenshot('can3373-$_stage-$theme-$step');

      // The test binding renders only pumped frames, and the chat feed lands
      // on its newest row over several of them before showing it.
      Future<void> frames(int count) async {
        for (var i = 0; i < count; i++) {
          await tester.pump(const Duration(milliseconds: 32));
        }
      }

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        can3373ChatHost(
          vm,
          _chat,
          themeMode: theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
        ),
      );
      await capture('1-first-frame');
      await frames(2);
      await capture('1b-first-paint');
      await frames(25);
      await capture('2-waiting-for-network');

      repository.releaseServerTail(
        _chat,
        can3373Rows(_chat, _size - 30, _size + 1),
      );
      await frames(25);
      await capture('3-server-tail');

      repository.deliverSnapshot(
        _chat,
        can3373Rows(_chat, _size - 20, _size + 2),
        cursor: 1,
        truncated: true,
      );
      await frames(25);
      await capture('4-desktop-snapshot');

      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
      await storage.clear();
    }
  });
}
