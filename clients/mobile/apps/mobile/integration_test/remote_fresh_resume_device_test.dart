// Device check for the return after a long background: the open chat moves
// straight to the current state instead of replaying the events it missed.
// Run from apps/mobile with the native lifecycle driver (see
// test_driver/remote_hydration_lifecycle.dart for the host environment):
//
//   flutter drive --driver=test_driver/remote_hydration_lifecycle.dart \
//     --target=integration_test/remote_fresh_resume_device_test.dart \
//     --dart-define=FRESH_RESUME_AWAY=75 -d <device-id>
//
// The production repository and event stream talk to a synthetic Portal
// server that pages its event log from the cursor, 25 events per poll, with
// [_latency] per request. While the app is away the "desktop" streams
// [_backlog] revisions of one reply. After the return the test samples every
// frame and reports each reply revision the chat painted, so a run on code
// that replays the backlog shows the stepping and a run that reloads shows
// one jump. No desktop or network; screenshots land in
// build/promo_screenshots.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/cursor_portal_server.dart';
import '../test/support/memory_remote_transcript_storage.dart';

const _away = int.fromEnvironment('FRESH_RESUME_AWAY', defaultValue: 75);
const _backlog = int.fromEnvironment('FRESH_RESUME_BACKLOG', defaultValue: 900);
const _latency = Duration(
  milliseconds: int.fromEnvironment(
    'FRESH_RESUME_LATENCY_MS',
    defaultValue: 200,
  ),
);

/// Matches the app's threshold, kept literal so the same file runs on code
/// from before it existed.
const _freshAfterSeconds = 60;

const _done = 'Done: all $_backlog steps finished.';

Map<String, dynamic> _message(
  String id,
  String role,
  String text, {
  bool streaming = false,
  int at = 0,
}) => {
  'messageId': id,
  'chatId': CursorPortalServer.chatId,
  'scope': 'standalone',
  'role': role,
  'status': streaming ? 'streaming' : 'complete',
  'text': text,
  'createdAtMs': 1792760000000 + at,
};

Map<String, dynamic> _progress(int step) => _message(
  'a2',
  'assistant',
  'Progress update $step',
  streaming: true,
  at: 2,
);

final class _Trace with WidgetsBindingObserver {
  _Trace(this.onPaused);

  final void Function() onPaused;
  final stopwatch = Stopwatch()..start();
  final events = <Map<String, Object?>>[];

  void record(String event, [Map<String, Object?> data = const {}]) => events
      .add({'event': event, 'ms': stopwatch.elapsedMilliseconds, ...data});

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    record('lifecycle', {'state': state.name});
    if (state == AppLifecycleState.paused) onPaused();
  }

  int? lastMs(String state) =>
      events
              .where((e) => e['event'] == 'lifecycle' && e['state'] == state)
              .lastOrNull?['ms']
          as int?;
}

Future<void> _requestBackground(int seconds) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('http://127.0.0.1:18766/background?seconds=$seconds'),
    );
    final response = await request.close().timeout(const Duration(seconds: 20));
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode != 200) throw StateError(body);
  } finally {
    client.close(force: true);
  }
}

/// The reply revision the chat paints: a step number, `done`, or null when
/// the reply is not on screen. Chat text is selectable, so it is an
/// [EditableText].
String? _paintedReply() {
  final finder = find.textContaining(
    RegExp(r'Progress update \d+|Done: all'),
    findRichText: true,
  );
  for (final element in finder.evaluate()) {
    final widget = element.widget;
    final text = switch (widget) {
      EditableText(:final controller) => controller.text,
      Text(:final data, :final textSpan) => data ?? textSpan?.toPlainText(),
      RichText(:final text) => text.toPlainText(),
      _ => null,
    };
    if (text == null) continue;
    if (text.contains(_done)) return 'done';
    final step = RegExp(r'Progress update (\d+)').firstMatch(text);
    if (step != null) return step.group(1);
  }
  return null;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'fresh resume after ${_away}s away',
    (tester) async {
      final server = CursorPortalServer(pollLatency: _latency)
        ..upsertMessage(
          _message('q1', 'user', 'Why does the release build fail?'),
        )
        ..upsertMessage(
          _message(
            'a1',
            'assistant',
            'The signing key expired. Rotating it and rerunning the job.',
            at: 1,
          ),
        )
        ..upsertMessage(_progress(0));
      var backlogSent = false;
      final trace = _Trace(() {
        // Delivery already stopped on `hidden`; these arrive while away.
        if (backlogSent) return;
        backlogSent = true;
        for (var step = 4; step <= _backlog; step++) {
          server.upsertMessage(_progress(step));
        }
        server.upsertMessage(_message('a2', 'assistant', _done, at: 2));
      })..record('start', {'pid': pid});
      trace.record('config', {
        'awaySeconds': _away,
        'backlog': _backlog,
        'latencyMs': _latency.inMilliseconds,
      });
      binding.addObserver(trace);
      addTearDown(() => binding.removeObserver(trace));

      final vm = RemoteControlViewModel(
        repository: server.repository(),
        transcriptCache: RemoteTranscriptCache(
          storage: MemoryRemoteTranscriptStorage(),
          accountScope: 'device:1',
        ),
      );
      await vm.restoreIfIdle();
      final navigator = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            navigatorKey: navigator,
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: ThemeMode.light,
            home: const RemoteScreen(),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 500));
      unawaited(
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => const RemoteChatScreen.standalone(
              standaloneChat: RemoteStandaloneChat(
                localId: CursorPortalServer.chatId,
                projectLocalId: CursorPortalServer.projectId,
                title: 'Release build',
              ),
            ),
          ),
        ),
      );

      Future<void> frames(Duration duration) async {
        final end = trace.stopwatch.elapsed + duration;
        while (trace.stopwatch.elapsed < end) {
          await tester.pump(const Duration(milliseconds: 16));
        }
      }

      void report(Map<String, Object?> data) => binding.reportData = {
        ...?binding.reportData,
        ...data,
        'events': trace.events,
      };

      var surfaceConverted = false;
      Future<void> screenshot(String name) async {
        // Android converts the surface once; later frames keep drawing to it.
        if (Platform.isAndroid && !surfaceConverted) {
          surfaceConverted = true;
          await binding.convertFlutterSurfaceToImage();
          await tester.pump(const Duration(milliseconds: 300));
        }
        await binding.takeScreenshot('fresh-resume-${_away}s-$name');
      }

      await frames(const Duration(seconds: 3));
      expect(_paintedReply(), '0');
      // Live updates while the app is open stream in as usual.
      for (var step = 1; step <= 3; step++) {
        server.upsertMessage(_progress(step));
        await frames(const Duration(milliseconds: 400));
      }
      final beforeAway = _paintedReply();
      trace.record('before-away', {
        'painted': beforeAway,
        'transcriptRequests': server.transcriptRequests,
        'stateReads': server.stateReads,
      });
      expect(beforeAway, '3');
      await screenshot('before');

      final pausedBefore = trace.lastMs('paused');
      final resumedBefore = trace.lastMs('resumed');
      final pollsBeforeReturn = server.pollCursors.length;
      final readsBeforeReturn = server.stateReads;
      final requestsBeforeReturn = server.transcriptRequests;
      await _requestBackground(_away);
      final deadline = trace.stopwatch.elapsed + Duration(seconds: _away + 60);
      int? resumedAt;
      while (trace.stopwatch.elapsed < deadline) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        final paused = trace.lastMs('paused');
        final resumed = trace.lastMs('resumed');
        if (paused != null &&
            paused != pausedBefore &&
            resumed != null &&
            resumed != resumedBefore &&
            resumed > paused) {
          resumedAt = resumed;
          trace.record('cycle-complete', {'awayMs': resumed - paused});
          break;
        }
      }
      if (resumedAt == null) fail('The app did not go to the background');

      // Every distinct reply revision the chat paints after the return.
      final painted = <Map<String, Object?>>[];
      int? doneAt;
      final watchUntil = trace.stopwatch.elapsed + const Duration(seconds: 25);
      // No screenshot here: one would stall sampling and hide frames.
      while (trace.stopwatch.elapsed < watchUntil) {
        await tester.pump(const Duration(milliseconds: 16));
        final value = _paintedReply();
        final ms = trace.stopwatch.elapsedMilliseconds - resumedAt;
        if (painted.isEmpty || painted.last['reply'] != value) {
          painted.add({'ms': ms, 'reply': value});
        }
        if (value == 'done') {
          doneAt ??= ms;
          if (ms - doneAt > 2000) break;
        }
      }
      final intermediate = [
        for (final entry in painted)
          if (entry['reply'] != beforeAway && entry['reply'] != 'done')
            entry['reply'],
      ];
      final returnPolls = server.pollCursors.sublist(pollsBeforeReturn);
      final result = {
        'painted': painted,
        'intermediateRevisions': intermediate.length,
        'doneAfterReturnMs': doneAt,
        'pollsAfterReturn': returnPolls.length,
        'oldestPolledCursor': returnPolls.isEmpty
            ? null
            : returnPolls.reduce((a, b) => a < b ? a : b),
        'backlogEndCursor': server.cursor,
        'stateReadsAfterReturn': server.stateReads - readsBeforeReturn,
        'transcriptRequestsAfterReturn':
            server.transcriptRequests - requestsBeforeReturn,
      };
      trace.record('result', result);
      report(result);
      await screenshot('settled');

      expect(doneAt, isNotNull, reason: 'the final reply never painted');
      expect(find.text('Why does the release build fail?'), findsOneWidget);
      if (_away > _freshAfterSeconds) {
        // One jump: nothing the backlog streamed is painted on the way.
        expect(intermediate, isEmpty);
        expect(result['transcriptRequestsAfterReturn'], 1);
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      server.close();
    },
    timeout: const Timeout(Duration(minutes: 6)),
  );
}
