// Chat body rebuild cost under live Remote Control traffic (CAN-3428,
// CAN-3371), in profile mode. Android emulators with an arm64 image run
// profile builds; physical devices give the representative frame times. Run
// from apps/mobile with:
//
//   flutter drive --profile --no-dds \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/remote_chat_rebuild_profile_test.dart \
//     -d <device-id>
//
// `--no-dds` lets the test reach the VM service to record its timeline.
//
// Opens a worktree chat holding a 320-row transcript (64 finished turns of
// prompt, tool step, tool result, answer and turn timer), then records three
// separate 30-second windows: idle; unrelated traffic only (a chat in another
// worktree streaming at 4 Hz, PR progress at 2 Hz and read-receipt retries
// against a failing acknowledgement); and the open chat streaming its answer
// at 4 Hz. For each it reports `RemoteChatBody.build` spans from the timeline
// and the frame build-time distribution (UI thread). The repository is the
// local fake: no pairing, desktop, or network.

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _window = Duration(seconds: 30);
const _tick = Duration(milliseconds: 250);
const _turns = 64;
final _epoch = DateTime.utc(2026, 1, 1, 9);

RemoteChatSummary _summary(
  String chatId,
  String worktreeLocalId, {
  bool turnActive = false,
}) => RemoteChatSummary(
  chatId: chatId,
  scope: RemoteChatScope.worktree,
  workspaceLocalId: 'ws-1',
  worktreeLocalId: worktreeLocalId,
  title: chatId == 'chat-a' ? 'Bound chat' : 'Other worktree chat',
  active: true,
  turnActive: turnActive,
);

/// One finished turn: prompt, a tool step, its result, the answer and the
/// completed turn timer.
List<RemoteChatMessage> _turn(int index) {
  final at = _epoch.add(Duration(minutes: index));
  RemoteChatMessage row(
    String id,
    ChatRole role, {
    String text = '',
    List<ChatPart> parts = const [],
  }) => RemoteChatMessage(
    messageId: '$id-$index',
    chatId: 'chat-a',
    scope: RemoteChatScope.worktree,
    role: role,
    status: ChatMessageStatus.complete,
    text: text,
    parts: parts,
    occurredAt: at,
  );
  return [
    row('prompt', ChatRole.user, text: 'Question $index about the build.'),
    row(
      'step',
      ChatRole.assistant,
      text: 'Checking the workspace for $index.',
      parts: [
        ChatPart(
          kind: 'tool_use',
          toolFamily: 'bash',
          data: {
            'toolName': 'Bash',
            'toolUseId': 'tool-$index',
            'input': '{"command":"npm test -- $index"}',
          },
        ),
      ],
    ),
    row(
      'result',
      ChatRole.assistant,
      parts: [
        ChatPart(
          kind: 'tool_result',
          data: {'toolUseId': 'tool-$index', 'output': 'ok $index'},
        ),
      ],
    ),
    row(
      'answer',
      ChatRole.assistant,
      text:
          'Answer $index: the build passes and the change is ready. '
          'Enough text to wrap onto a second line on a phone.',
    ),
    row(
      'timer',
      ChatRole.assistant,
      parts: [
        ChatPart(
          kind: 'turn_timer',
          data: {
            'startedAt': at.millisecondsSinceEpoch,
            'completedAt': at
                .add(const Duration(seconds: 42))
                .millisecondsSinceEpoch,
          },
        ),
      ],
    ),
  ];
}

RemoteSessionSnapshot _snapshot() => RemoteSessionSnapshot(
  workspaces: const [],
  standaloneChats: const [],
  worktrees: const [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
    RemoteWorktree(localId: 'wt-2', workspaceLocalId: 'ws-1', branch: 'other'),
  ],
  chatSummaries: [_summary('chat-a', 'wt-1'), _summary('chat-c', 'wt-2')],
  chatMessages: [for (var i = 0; i < _turns; i++) ..._turn(i)],
);

RemoteChatMessageEvent _streaming(String chatId, int tick) =>
    RemoteChatMessageEvent(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      message: RemoteChatMessage(
        messageId: 'live-$chatId',
        chatId: chatId,
        scope: RemoteChatScope.worktree,
        role: ChatRole.assistant,
        status: ChatMessageStatus.streaming,
        text: 'Streaming $chatId update $tick',
        occurredAt: _epoch.add(const Duration(days: 1)),
      ),
    );

double _percentile(List<int> sorted, double fraction) => sorted.isEmpty
    ? 0
    : sorted[((sorted.length - 1) * fraction).round()] / 1000;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('chat body builds under live traffic', (tester) async {
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = _snapshot
      ..markReadHandler = (_, _) async =>
          throw const RemoteControlException('offline');
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    final worktree = viewModel
        .worktreesFor('ws-1')
        .firstWhere((row) => row.localId == 'wt-1');
    expect(
      viewModel
          .messagesFor(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              chatId: 'chat-a',
            ),
          )
          .length,
      greaterThanOrEqualTo(300),
    );

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

    var cursor = 0;
    void send(List<RemotePortalEvent> events) => repository.eventsController
        .add(RemotePortalEventBatch(nextCursor: ++cursor, events: events));

    final windows = <String, Object>{};
    Future<void> record(String name, void Function(int tick) traffic) async {
      final buildMicros = <int>[];
      void onTimings(List<FrameTiming> timings) {
        for (final timing in timings) {
          buildMicros.add(timing.buildDuration.inMicroseconds);
        }
      }

      SchedulerBinding.instance.addTimingsCallback(onTimings);
      await binding.traceAction(
        () async {
          final elapsed = Stopwatch()..start();
          var tick = 0;
          while (elapsed.elapsed < _window) {
            traffic(++tick);
            await Future<void>.delayed(_tick);
          }
          // Only the Dart stream carries the span; recording every stream
          // overflows the timeline buffer and drops early spans.
        },
        streams: const ['Dart'],
        reportKey: 'timeline_$name',
      );
      SchedulerBinding.instance.removeTimingsCallback(onTimings);

      var bodyBuilds = 0;
      final bodyBuildMicros = <int>[];
      final timeline = binding.reportData?.remove('timeline_$name');
      if (timeline case {'traceEvents': final List<Object?> events}) {
        final begins = <int>[];
        for (final event in events) {
          if (event case {
            'name': 'RemoteChatBody.build',
            'ph': final String phase,
            'ts': final int ts,
          }) {
            if (phase == 'B' || phase == 'X') bodyBuilds += 1;
            if (phase == 'B') begins.add(ts);
            if (phase == 'E' && begins.isNotEmpty) {
              bodyBuildMicros.add(ts - begins.removeLast());
            }
            if (phase == 'X') {
              if (event['dur'] case final int duration) {
                bodyBuildMicros.add(duration);
              }
            }
          }
        }
      }
      buildMicros.sort();
      bodyBuildMicros.sort();
      final frames = buildMicros.length;
      windows[name] = {
        'bodyBuilds': bodyBuilds,
        'bodyBuildP50Ms': _percentile(bodyBuildMicros, 0.5),
        'bodyBuildP90Ms': _percentile(bodyBuildMicros, 0.9),
        'frames': frames,
        'averageFrameBuildMs': frames == 0
            ? 0
            : buildMicros.reduce((a, b) => a + b) / frames / 1000,
        'p50FrameBuildMs': _percentile(buildMicros, 0.5),
        'p90FrameBuildMs': _percentile(buildMicros, 0.9),
        'p99FrameBuildMs': _percentile(buildMicros, 0.99),
        'maxFrameBuildMs': frames == 0 ? 0 : buildMicros.last / 1000,
        'framesOver8Ms': buildMicros.where((micros) => micros > 8000).length,
      };
    }

    await record('idle', (_) {});
    await record('otherTraffic', (tick) {
      send([
        _streaming('chat-c', tick),
        if (tick.isEven)
          RemoteStateDeltaEvent(
            prProgress: {
              'ws-1:wt-1': RemotePrProgressState(
                creation: RemotePrCreationProgress(
                  steps: const [],
                  currentPhase: tick % 4 == 0
                      ? RemotePrCreationPhase.pushing
                      : RemotePrCreationPhase.summarizing,
                ),
              ),
            },
          ),
      ]);
    });
    send([
      RemoteStateDeltaEvent(
        chatSummaries: [_summary('chat-a', 'wt-1', turnActive: true)],
      ),
      RemoteChatMessageEvent(
        chatId: 'chat-a',
        scope: RemoteChatScope.worktree,
        message: RemoteChatMessage(
          messageId: 'live-prompt',
          chatId: 'chat-a',
          scope: RemoteChatScope.worktree,
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'One more change, please.',
          occurredAt: _epoch.add(const Duration(hours: 23)),
        ),
      ),
    ]);
    await Future<void>.delayed(const Duration(seconds: 1));
    await record('boundStreaming', (tick) {
      send([_streaming('chat-a', tick)]);
    });

    final summary = <String, Object>{
      'transcriptRows': _turns * 5,
      'windowSeconds': _window.inSeconds,
      'trafficHz': 1000 ~/ _tick.inMilliseconds,
      'windows': windows,
    };
    (binding.reportData ??= {})['rebuild_profile'] = summary;
    debugPrint('CAN-3371 rebuild profile: $summary');
    expect(
      (windows['boundStreaming']! as Map<String, Object>)['bodyBuilds'],
      greaterThan(0),
    );
    await tester.pumpWidget(const SizedBox());
    viewModel.dispose();
  });
}
