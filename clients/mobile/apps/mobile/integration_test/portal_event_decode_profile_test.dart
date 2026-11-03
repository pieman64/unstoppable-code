// Portal event decode cost on the UI isolate while a large chat snapshot
// arrives (CAN-3372), in profile mode. Bytes go through the real
// `PortalEventStream` (SSE, and long-poll behind a forced SSE 404) and the
// batches it emits feed the real view model and an open Remote chat screen,
// so every sample includes production parsing, decoding, model mapping, the
// isolate handoff when there is one, and the downstream store/render work.
// Run from apps/mobile on the unchanged and the changed tree with:
//
//   flutter drive --profile --no-dds \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/portal_event_decode_profile_test.dart \
//     --dart-define=CAN3372_STAGE=before -d <device-id>
//
// `--no-dds` lets the test reach the VM service to record its timeline. The
// summary, and the raw timeline of every sample with a long task, land in
// build/integration_response_data.json.
// Android emulators with an arm64 image run profile builds; physical devices
// give the representative frame times. Synthetic data only: the repository
// is the local fake, with no pairing, desktop or network.
//
// For each scenario it reports delivery time, the longest UI-isolate task
// (largest gap in an event-loop heartbeat), frame build/raster timings,
// timeline spans for transport parsing (`PortalEventStream.parseChunk`),
// inline decodes (`PortalEventDecoder.inline`) and worker decodes
// (`PortalEventDecoder.isolate`), stop-the-world GC pauses, and for every
// sample the work that overlapped its longest gap (`perSample`, see
// `portal_timeline_attribution.dart`). The portal spans exist only on the
// changed tree; the heartbeat, frame and GC timings compare both.
//
// `--dart-define=CAN3372_SAMPLES=<n>` changes the sample count (default 10)
// and `--dart-define=CAN3372_SCENARIOS=<name>,<name>` runs only the named
// scenarios.

import 'dart:developer';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
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
import '../test/support/portal_timeline_attribution.dart';
import '../test/support/portal_transport_driver.dart';

const _stage = String.fromEnvironment('CAN3372_STAGE', defaultValue: 'after');
const _warmups = 2;
const _samples = int.fromEnvironment('CAN3372_SAMPLES', defaultValue: 10);
const _scenarioFilter = String.fromEnvironment('CAN3372_SCENARIOS');
const _kib = 1024;

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

double _ms(int micros) => micros / 1000;

Map<String, double> _distribution(List<int> micros) {
  if (micros.isEmpty) return const {'count': 0};
  final sorted = [...micros]..sort();
  double at(double fraction) =>
      _ms(sorted[((sorted.length - 1) * fraction).round()]);
  return {
    'count': sorted.length.toDouble(),
    'p50Ms': at(0.5),
    'p90Ms': at(0.9),
    'p99Ms': at(0.99),
    'maxMs': _ms(sorted.last),
    'over8Ms': sorted.where((value) => value > 8000).length.toDouble(),
    'over16Ms': sorted.where((value) => value > 16000).length.toDouble(),
  };
}

/// Portal span and GC pause distributions over every sample's timeline,
/// and the attribution of each sample's longest UI-isolate gap.
Map<String, Object> _timelineReport(
  String uiThread,
  Map<String, List<int>> durations,
  List<Map<String, Object>> perSample,
) {
  final causes = <String, int>{};
  for (final sample in perSample) {
    final cause = sample['cause']! as String;
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return {
    'uiThread': uiThread,
    for (final MapEntry(key: name, value: micros) in durations.entries)
      name: _distribution(micros),
    'longestGapCauses': causes,
    'perSample': perSample,
  };
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('portal event decode under a large snapshot', (tester) async {
    final repository = FakeRemoteControlRepository()..snapshotBuilder = _shell;
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    final worktree = viewModel.worktreesFor(workloadWorkspaceId).single;
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
          home: RemoteChatScreen.worktree(worktree: worktree),
        ),
      ),
    );
    await Future<void>.delayed(const Duration(seconds: 2));

    final driver = PortalTransportDriver(repository);
    var cursor = 100;
    final scenarios = <String, Future<PortalDelivery?> Function()>{
      'idle': () async {
        await Future<void>.delayed(const Duration(seconds: 1));
        return null;
      },
      for (final workload in ['snapshot600KiB', 'snapshotNearCap'])
        for (final chunk in [
          if (workload == 'snapshot600KiB') _kib,
          16 * _kib,
          null,
        ])
          'sse-$workload-${chunk == null ? 'coalesced' : 'chunk${chunk ~/ _kib}KiB'}':
              () {
                final json = portalDeviceSnapshot(workload, ++cursor);
                return driver.sse(
                  sseFrame(json),
                  untilCursor: cursor,
                  chunkBytes: chunk,
                  pace: chunk == null
                      ? Duration.zero
                      : const Duration(milliseconds: 1),
                );
              },
      for (final workload in ['snapshot600KiB', 'snapshotNearCap'])
        'longpoll-$workload': () =>
            driver.longPoll(portalDeviceSnapshot(workload, ++cursor)),
    };

    final selected = {
      for (final name in _scenarioFilter.split(','))
        if (name.trim().isNotEmpty) name.trim(),
    };
    final results = <String, Object>{};
    for (final MapEntry(key: name, value: run) in scenarios.entries) {
      if (selected.isNotEmpty && !selected.contains(name)) continue;
      for (var i = 0; i < _warmups; i++) {
        await run();
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
      final buildMicros = <int>[];
      final rasterMicros = <int>[];
      final totalMicros = <int>[];
      void onTimings(List<FrameTiming> timings) {
        for (final timing in timings) {
          buildMicros.add(timing.buildDuration.inMicroseconds);
          rasterMicros.add(timing.rasterDuration.inMicroseconds);
          totalMicros.add(timing.totalSpan.inMicroseconds);
        }
      }

      final deliveryMicros = <int>[];
      final maxTaskMicros = <int>[];
      final heartbeatGaps = <int>[];
      final durations = <String, List<int>>{};
      final perSample = <Map<String, Object>>[];
      var uiThread = '';
      var rows = 0;
      SchedulerBinding.instance.addTimingsCallback(onTimings);
      for (var i = 0; i < _samples; i++) {
        // One timeline per sample, so the VM's bounded timeline buffer
        // cannot drop the early samples of a long scenario.
        final reportKey = 'timeline_${name}_$i';
        late EventLoopHeartbeat heartbeat;
        await binding.traceAction(
          () async {
            Timeline.startSync(sampleSpan);
            heartbeat = EventLoopHeartbeat()..start();
            final delivery = await run();
            // Let the store and the screen apply the batch inside the window.
            await Future<void>.delayed(const Duration(milliseconds: 300));
            final gaps = heartbeat.stop();
            Timeline.finishSync();
            heartbeatGaps.addAll(gaps);
            maxTaskMicros.add(gaps.reduce((a, b) => a > b ? a : b));
            if (delivery != null) {
              deliveryMicros.add(delivery.elapsed.inMicroseconds);
            }
          },
          streams: const ['Dart', 'GC'],
          reportKey: reportKey,
        );
        final timeline = PortalTimeline.parse(binding.reportData?[reportKey]);
        uiThread = timeline.uiThread ?? uiThread;
        for (final MapEntry(key: span, value: micros)
            in timeline.durations().entries) {
          (durations[span] ??= []).addAll(micros);
        }
        final attribution = timeline.attribute(
          heartbeat.longestGapStart,
          heartbeat.longestGapEnd,
        );
        perSample.add(attribution);
        // Keep the raw timeline only for samples with a long task.
        if (attribution['cause'] == 'none') {
          binding.reportData?.remove(reportKey);
        }
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
      SchedulerBinding.instance.removeTimingsCallback(onTimings);
      rows = viewModel
          .messagesFor(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: workloadWorkspaceId,
              worktreeLocalId: workloadWorktreeId,
              chatId: workloadChatId,
            ),
          )
          .length;
      results[name] = {
        'samples': _samples,
        'warmups': _warmups,
        'transcriptRows': rows,
        'deliveryMs': _distribution(deliveryMicros),
        'maxUiTaskPerSampleMs': _distribution(maxTaskMicros),
        'uiTaskGapsMs': _distribution(heartbeatGaps),
        'frameBuildMs': _distribution(buildMicros),
        'frameRasterMs': _distribution(rasterMicros),
        'frameTotalSpanMs': _distribution(totalMicros),
        'timeline': _timelineReport(uiThread, durations, perSample),
      };
      debugPrint('CAN-3372 $name: ${results[name]}');
      expect(tester.takeException(), isNull);
    }

    (binding.reportData ??= {})['can3372_profile'] = {
      'stage': _stage,
      'sseCapChars': 1024 * 1024,
      'workloads': {
        'snapshot600KiB': {
          'chars': snapshot600KiBChars,
          'utf8Bytes': utf8Length(portalDeviceSnapshot('snapshot600KiB', 1)),
          'messages': 300,
        },
        'snapshotNearCap': {
          'chars': portalDeviceSnapshot('snapshotNearCap', 1).length,
          'utf8Bytes': utf8Length(portalDeviceSnapshot('snapshotNearCap', 1)),
          'messages': 300,
        },
      },
      'scenarios': results,
    };
    for (final MapEntry(key: name, value: result) in results.entries) {
      if (name == 'idle') continue;
      expect((result as Map)['transcriptRows'], greaterThanOrEqualTo(300));
    }
    await tester.pumpWidget(const SizedBox());
    viewModel.dispose();
  });
}
