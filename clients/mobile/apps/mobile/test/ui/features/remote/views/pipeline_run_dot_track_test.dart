import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_display.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_run_dot_track.dart';

List<List<PipelineRunDot>> tiersOf(
  int count, {
  int perTier = 4,
  int? runningIndex,
}) {
  final tiers = <List<PipelineRunDot>>[];
  for (var index = 0; index < count; index++) {
    if (index % perTier == 0) tiers.add([]);
    tiers.last.add(
      PipelineRunDot(
        jobId: 'job-$index',
        name: 'Job $index',
        status: index == runningIndex
            ? PipelineRunDotStatus.running
            : index < (runningIndex ?? count)
            ? PipelineRunDotStatus.success
            : PipelineRunDotStatus.pending,
      ),
    );
  }
  return tiers;
}

Widget host(List<List<PipelineRunDot>> tiers, {double width = 160}) =>
    MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: width,
            child: PipelineRunDotTrack(executionId: 'exec-1', tiers: tiers),
          ),
        ),
      ),
    );

void main() {
  const left = ValueKey('pipeline-run-dots-scroll-left');
  const right = ValueKey('pipeline-run-dots-scroll-right');

  ScrollPosition positionOf(WidgetTester tester) => tester
      .state<ScrollableState>(
        find.descendant(
          of: find.byType(PipelineRunDotTrack),
          matching: find.byType(Scrollable),
        ),
      )
      .position;

  testWidgets('a track that fits shows no chevrons', (tester) async {
    await tester.pumpWidget(host(tiersOf(4), width: 300));
    await tester.pumpAndSettle();

    expect(find.byKey(left), findsNothing);
    expect(find.byKey(right), findsNothing);
  });

  testWidgets('an overflowing track steps with its chevrons', (tester) async {
    await tester.pumpWidget(host(tiersOf(30)));
    await tester.pumpAndSettle();

    expect(find.byKey(left), findsNothing);
    expect(find.byKey(right), findsOneWidget);

    await tester.tap(find.byKey(right));
    await tester.pumpAndSettle();
    expect(positionOf(tester).pixels, PipelineRunDotTrack.scrollStep);
    expect(find.byKey(left), findsOneWidget);

    await tester.tap(find.byKey(left));
    await tester.pumpAndSettle();
    expect(positionOf(tester).pixels, 0);
    expect(find.byKey(left), findsNothing);
  });

  testWidgets('centers the first running job out of view', (tester) async {
    await tester.pumpWidget(host(tiersOf(30, runningIndex: 24)));
    // The running dot pulses forever, so settle by time, not by frames.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final track = tester.getRect(find.byType(PipelineRunDotTrack));
    final dot = tester.getCenter(
      find.byKey(const ValueKey('pipeline-run-dot:exec-1:job-24')),
    );
    expect(positionOf(tester).pixels, greaterThan(0));
    expect(dot.dx, closeTo(track.center.dx, 1));
  });

  testWidgets('running dots pulse, finished ones stay still', (tester) async {
    Finder fade(String id) => find.descendant(
      of: find.byType(PipelineRunDotTrack),
      matching: find.ancestor(
        of: find.byKey(ValueKey('pipeline-run-dot:exec-1:$id')),
        matching: find.byType(FadeTransition),
      ),
    );
    await tester.pumpWidget(host(tiersOf(4, runningIndex: 1), width: 300));
    await tester.pump();
    expect(fade('job-0'), findsNothing);
    final opacity = tester.widget<FadeTransition>(fade('job-1')).opacity;
    // A two-second cycle: full, down to half at one second, back to full.
    expect(opacity.value, 1);
    await tester.pump(const Duration(seconds: 1));
    expect(opacity.value, closeTo(0.5, 0.01));
    await tester.pump(const Duration(milliseconds: 500));
    expect(opacity.value, closeTo(0.75, 0.01));

    // Once nothing runs the ticker stops, so the tree can settle.
    await tester.pumpWidget(host(tiersOf(4), width: 300));
    await tester.pumpAndSettle();
    expect(fade('job-1'), findsNothing);
  });
}
