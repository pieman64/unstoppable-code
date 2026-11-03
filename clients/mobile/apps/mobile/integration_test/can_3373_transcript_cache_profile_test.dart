// CAN-3373 measurements, in profile mode. Android emulators with an arm64
// image run profile builds; physical devices give the representative
// numbers. Run from apps/mobile with:
//
//   flutter drive --profile --no-dds --no-pub \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3373_transcript_cache_profile_test.dart \
//     -d <device-id>
//
// Reports, in the response data and a CAN3373_PROFILE log line:
// - reopen: time from mounting a chat to the first frame showing its newest
//   message, with and without a persisted tail, for 10- and 300-message
//   chats, after a warm-up. The server-cached tail answers after the same
//   simulated latency in both cases; the desktop snapshot never answers in
//   the window. Startup cache loading is reported separately.
// - streaming: writes and bytes while the open chat streams an answer at
//   4 Hz for 30 seconds, and whether the final revision was persisted.
// - footprint: bytes on disk for 20 chats of 50 messages.
// Uses the production storage and the synthetic repository; no network.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/remote_transcript_cache_fixture.dart';

const _repetitions = 5;
const _serverLatency = Duration(milliseconds: 400);
const _streamWindow = Duration(seconds: 30);
const _streamTick = Duration(milliseconds: 250);
const _owner = (
  accountScope: kCan3373AccountScope,
  sessionId: kCan3373SessionId,
);

/// Records what the cache asked to write, for counting after the window so
/// the measurement adds no encoding to the UI isolate while it runs.
final class _RecordingStorage implements RemoteTranscriptStorage {
  _RecordingStorage(this.inner);

  final RemoteTranscriptStorage inner;
  final writes = <({Duration at, PersistedTranscript transcript})>[];
  final clock = Stopwatch()..start();

  @override
  Future<List<PersistedTranscript>> load(RemoteTranscriptOwner owner) =>
      inner.load(owner);

  @override
  void write(RemoteTranscriptOwner owner, PersistedTranscript transcript) {
    writes.add((at: clock.elapsed, transcript: transcript));
    inner.write(owner, transcript);
  }

  @override
  void delete(RemoteTranscriptOwner owner, RemoteTranscriptChat chat) =>
      inner.delete(owner, chat);

  @override
  Future<void> clear() => inner.clear();

  @override
  Future<void> flush() => inner.flush();
}

Map<String, num> _stats(List<double> samples) {
  final sorted = [...samples]..sort();
  double at(double q) => sorted[((sorted.length - 1) * q).round()];
  return {
    'n': sorted.length,
    'min': sorted.first,
    'median': at(0.5),
    'p95': at(0.95),
    'max': sorted.last,
  };
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final report = <String, Object?>{
    'mode': kProfileMode ? 'profile' : (kReleaseMode ? 'release' : 'debug'),
  };

  FileRemoteTranscriptStorage files() =>
      FileRemoteTranscriptStorage(directory: remoteTranscriptCacheDirectory);

  /// One reopen of a [size]-message chat; returns milliseconds to the first
  /// frame showing its newest message, and frame timings meanwhile.
  Future<Map<String, Object?>> reopen(
    WidgetTester tester, {
    required int size,
    required bool cached,
  }) async {
    const chat = Can3373Chat.standalone;
    final storage = files();
    await storage.clear();
    if (cached) {
      storage.write(
        _owner,
        PersistedTranscript(
          chat: (scope: chat.scope, chatId: chat.chatId),
          openedAt: 1,
          rows: can3373Rows(
            chat,
            size > kRemoteTranscriptCacheMaxMessages
                ? size - kRemoteTranscriptCacheMaxMessages
                : 0,
            size,
          ),
        ),
      );
      await storage.flush();
    }
    final repository = Can3373Repository()..latency = _serverLatency;
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      transcriptCache: RemoteTranscriptCache(
        storage: files(),
        accountScope: kCan3373AccountScope,
      ),
    );
    final launch = Stopwatch()..start();
    await vm.connect('123456');
    final connectMs = launch.elapsedMicroseconds / 1000;
    await vm.transcriptCache!.restoreSession(kCan3373SessionId);
    final warmMs = launch.elapsedMicroseconds / 1000;
    // The server tail is ready; it answers after the simulated latency.
    repository.releaseServerTail(
      chat,
      can3373Rows(chat, size > 50 ? size - 50 : 0, size),
    );
    await tester.pumpWidget(const SizedBox.shrink());

    final timings = <FrameTiming>[];
    void record(List<FrameTiming> frames) => timings.addAll(frames);
    SchedulerBinding.instance.addTimingsCallback(record);
    final newest = find.text(can3373Row(chat, size - 1).text);
    final open = Stopwatch()..start();
    await tester.pumpWidget(can3373ChatHost(vm, chat));
    var frames = 1;
    while (newest.evaluate().isEmpty &&
        open.elapsed < const Duration(seconds: 10)) {
      await tester.pump(const Duration(milliseconds: 8));
      frames += 1;
    }
    final firstMessageMs = open.elapsedMicroseconds / 1000;
    await tester.pump(const Duration(milliseconds: 200));
    SchedulerBinding.instance.removeTimingsCallback(record);
    expect(newest, findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
    return {
      'firstMessageMs': firstMessageMs,
      'framesUntilMessage': frames,
      'connectMs': connectMs,
      'warmMs': warmMs,
      'buildMs': [
        for (final t in timings) t.buildDuration.inMicroseconds / 1000,
      ],
      'rasterMs': [
        for (final t in timings) t.rasterDuration.inMicroseconds / 1000,
      ],
    };
  }

  testWidgets('CAN-3373 cold reopen with and without a persisted tail', (
    tester,
  ) async {
    final reopenReport = <String, Object?>{};
    for (final size in [10, 300]) {
      for (final cached in [false, true]) {
        await reopen(tester, size: size, cached: cached); // warm-up
        final runs = [
          for (var i = 0; i < _repetitions; i++)
            await reopen(tester, size: size, cached: cached),
        ];
        double ms(Object? value) => (value! as num).toDouble();
        reopenReport['${size}msg-${cached ? 'cache' : 'no-cache'}'] = {
          'firstMessageMs': _stats([
            for (final run in runs) ms(run['firstMessageMs']),
          ]),
          'warmMs': _stats([for (final run in runs) ms(run['warmMs'])]),
          'connectMs': _stats([for (final run in runs) ms(run['connectMs'])]),
          'samples': runs,
        };
      }
    }
    report['reopen'] = reopenReport;
  });

  testWidgets('CAN-3373 writes while a chat streams at 4 Hz', (tester) async {
    const chat = Can3373Chat.standalone;
    final storage = _RecordingStorage(files());
    await storage.clear();
    final repository = Can3373Repository();
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      transcriptCache: RemoteTranscriptCache(
        storage: storage,
        accountScope: kCan3373AccountScope,
      ),
    );
    await vm.connect('123456');
    await tester.pumpWidget(can3373ChatHost(vm, chat));
    repository
      ..releaseServerTail(chat, const [])
      ..deliverSnapshot(chat, can3373Rows(chat, 0, 49), cursor: 1);
    await tester.pump(const Duration(seconds: 1));
    final initialWrites = storage.writes.length;

    final answer = StringBuffer();
    final ticks = _streamWindow.inMilliseconds ~/ _streamTick.inMilliseconds;
    final streamStart = storage.clock.elapsed;
    for (var tick = 0; tick < ticks; tick++) {
      answer.write('Token batch $tick of the streaming answer. ');
      final last = tick == ticks - 1;
      repository.deliverLive(
        chat,
        RemoteChatMessage(
          messageId: 'streaming-answer',
          chatId: chat.chatId,
          scope: chat.scope,
          role: ChatRole.assistant,
          status: last
              ? ChatMessageStatus.complete
              : ChatMessageStatus.streaming,
          text: answer.toString(),
          occurredAt: DateTime.utc(2026, 10, 4, 10),
          updatedAt: DateTime.utc(2026, 10, 4, 10).add(_streamTick * tick),
        ),
        2 + tick,
      );
      await tester.pump(_streamTick);
    }
    final streamEnd = storage.clock.elapsed;
    await tester.pump(const Duration(seconds: 1));
    await storage.flush();

    final streamed = [
      for (final write in storage.writes.skip(initialWrites))
        if (write.at >= streamStart && write.at <= streamEnd) write,
    ];
    final finalFlush = [
      for (final write in storage.writes.skip(initialWrites))
        if (write.at > streamEnd) write,
    ];
    int bytes(Iterable<({Duration at, PersistedTranscript transcript})> w) =>
        w.fold(
          0,
          (sum, write) =>
              sum + encodeRemoteTranscript(_owner, write.transcript)!.length,
        );
    final persisted = (await files().load(_owner)).single.rows.last;
    report['streaming'] = {
      'windowMs': (streamEnd - streamStart).inMilliseconds,
      'liveRevisions': ticks,
      'initialWrites': initialWrites,
      'streamWrites': streamed.length,
      'streamWriteBytes': bytes(streamed),
      'finalFlushWrites': finalFlush.length,
      'finalFlushBytes': bytes(finalFlush),
      'writeDelayMs': kRemoteTranscriptCacheWriteDelay.inMilliseconds,
      'finalRevisionPersisted':
          persisted.text == answer.toString() &&
          persisted.status == ChatMessageStatus.complete,
    };
    expect(report['streaming'], containsPair('finalRevisionPersisted', true));
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('CAN-3373 footprint of 20 chats of 50 messages', (tester) async {
    final storage = files();
    await storage.clear();
    for (var i = 0; i < kRemoteTranscriptCacheMaxChats; i++) {
      final chat = i.isEven ? Can3373Chat.worktree : Can3373Chat.standalone;
      storage.write(
        _owner,
        PersistedTranscript(
          chat: (scope: chat.scope, chatId: '${chat.chatId}-$i'),
          openedAt: i,
          rows: [
            for (final row in can3373Rows(chat, 0, 50))
              RemoteChatMessage(
                messageId: row.messageId,
                chatId: '${chat.chatId}-$i',
                scope: row.scope,
                role: row.role,
                status: row.status,
                text: row.text,
                occurredAt: row.occurredAt,
              ),
          ],
        ),
      );
    }
    await storage.flush();
    final directory = await remoteTranscriptCacheDirectory();
    final sizes = [
      for (final entity in directory.listSync())
        if (entity is File) entity.lengthSync(),
    ];
    report['footprint'] = {
      'files': sizes.length,
      'bytes': sizes.fold<int>(0, (a, b) => a + b),
      'maxFileBytes': sizes.reduce((a, b) => a > b ? a : b),
    };
    expect(sizes, hasLength(kRemoteTranscriptCacheMaxChats));
    await storage.clear();
  });

  tearDownAll(() {
    binding.reportData = {'can3373_profile': report};
    // ignore: avoid_print
    print('CAN3373_PROFILE ${jsonEncode(report)}');
  });
}
