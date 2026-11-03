import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/ui/core/app_icons.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/feed/views/feed_card.dart';

void main() {
  group('pipelineRunStatusColor', () {
    final colors = StatusColors.light;

    test('success is always green, per the shared status vocabulary', () {
      expect(pipelineRunStatusColor('success', colors), colors.success);
    });

    test('failure is always red', () {
      expect(pipelineRunStatusColor('failure', colors), colors.failed);
    });

    test('pending and neutral are muted, not error red', () {
      expect(pipelineRunStatusColor('pending', colors), colors.neutral);
      expect(pipelineRunStatusColor('neutral', colors), colors.neutral);
      expect(pipelineRunStatusColor('pending', colors), isNot(colors.failed));
    });
  });

  testWidgets('truncates a long title and long chip labels at phone width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13, 390 logical
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    const longTitle =
        'Implement the end-to-end activity feed screen with realtime updates, '
        'pagination, and per-item deep links across every product surface';
    const longRepo =
        'unstoppabledomains/some-extremely-long-monorepo-package-name-here';

    final item = PrMergedFeedItem(
      actor: const FeedActor(displayName: 'Alex Rivera', userId: 'u1'),
      id: 'f1',
      occurredAt: '2026-06-29T14:12:00.000Z',
      models: const [],
      prNumber: 1201,
      prUrl: 'https://github.com/example/canopy/pull/1201',
      repoName: longRepo,
      title: longTitle,
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: FeedCard(item: item)),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);

    final titleText = tester.widget<Text>(find.text(longTitle));
    expect(titleText.maxLines, 2);
    expect(titleText.overflow, TextOverflow.ellipsis);

    final chipText = tester.widget<Text>(find.text('$longRepo #1201'));
    expect(chipText.maxLines, 1);
    expect(chipText.overflow, TextOverflow.ellipsis);
  });

  testWidgets('shared plans and shared runs use the same share glyph', (
    tester,
  ) async {
    const actor = FeedActor(displayName: 'Alex Rivera', userId: 'u1');
    final items = <FeedItem>[
      PlanSharedFeedItem(
        actor: actor,
        id: 'plan',
        occurredAt: '2026-06-29T14:12:00.000Z',
        shareScope: 'team',
        sharedPlanId: 'p1',
        title: 'Release plan',
      ),
      RunSharedFeedItem(
        actor: actor,
        id: 'run',
        occurredAt: '2026-06-29T14:12:00.000Z',
        shareScope: 'team',
        sharedRunId: 'r1',
        status: 'completed',
        title: 'Release run',
        toolUseCount: 3,
        turnCount: 2,
      ),
    ];

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: ListView(
            children: [for (final item in items) FeedCard(item: item)],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(AppIcons.share), findsNWidgets(2));
    expect(find.byIcon(Icons.ios_share), findsNothing);
  });
}
