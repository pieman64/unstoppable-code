import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_host.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_sheet.dart';
import 'package:provider/provider.dart';

import '../../../../support/recording_product_analytics.dart';

final class _NoReview implements StoreReviewLauncher {
  @override
  Future<StoreReviewRequestResult> request() async =>
      StoreReviewRequestResult.unavailable;
}

const _delay = Duration(milliseconds: 1500);

void main() {
  late int shows;
  late SatisfactionPromptController controller;

  setUp(() {
    shows = 0;
    controller = SatisfactionPromptController(
      store: InMemorySatisfactionPromptStore(),
      analytics: RecordingProductAnalytics(),
      reviewLauncher: _NoReview(),
      isActive: () => true,
      thresholds: () => SatisfactionThresholds.verification,
      showPrompt: (_) async {
        shows++;
        return SatisfactionPromptChoice.notNow;
      },
    );
  });

  Widget app({required bool isQuiet}) =>
      ChangeNotifierProvider<SatisfactionPromptController>.value(
        value: controller,
        child: MaterialApp(
          home: SatisfactionPromptHost(
            surface: SatisfactionSurface.remoteChat,
            isQuiet: isQuiet,
            child: const Scaffold(body: Text('chat')),
          ),
        ),
      );

  testWidgets('presents after the settle delay when quiet', (tester) async {
    await tester.pumpWidget(app(isQuiet: true));
    await controller.recordSuccessfulTurn('remote:c:t1');
    await tester.pump(_delay - const Duration(milliseconds: 1));
    expect(shows, 0);
    await tester.pump(const Duration(milliseconds: 1));
    expect(shows, 1);
  });

  testWidgets('waits while the chat is not quiet, then presents', (
    tester,
  ) async {
    await tester.pumpWidget(app(isQuiet: false));
    await controller.recordSuccessfulTurn('remote:c:t1');
    await tester.pump(_delay * 2);
    expect(shows, 0);
    await tester.pumpWidget(app(isQuiet: true));
    await tester.pump(_delay);
    expect(shows, 1);
  });

  testWidgets('becoming busy during the delay cancels the prompt', (
    tester,
  ) async {
    await tester.pumpWidget(app(isQuiet: true));
    await controller.recordSuccessfulTurn('remote:c:t1');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpWidget(app(isQuiet: false));
    await tester.pump(_delay * 2);
    expect(shows, 0);
    expect(controller.pendingPrompt, isTrue);
  });

  testWidgets('a route pushed during the delay suppresses the prompt', (
    tester,
  ) async {
    await tester.pumpWidget(app(isQuiet: true));
    await controller.recordSuccessfulTurn('remote:c:t1');
    await tester.pump(const Duration(milliseconds: 500));
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.push(
      MaterialPageRoute<void>(builder: (_) => const Text('other')),
    );
    await tester.pumpAndSettle();
    await tester.pump(_delay * 2);
    expect(shows, 0);
    navigator.pop();
    await tester.pumpAndSettle();
    await tester.pump(_delay);
    expect(shows, 1);
  });

  testWidgets('backgrounding during the delay suppresses the prompt', (
    tester,
  ) async {
    await tester.pumpWidget(app(isQuiet: true));
    await controller.recordSuccessfulTurn('remote:c:t1');
    await tester.pump(const Duration(milliseconds: 500));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(_delay * 2);
    expect(shows, 0);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(_delay);
    expect(shows, 1);
  });

  testWidgets('renders the child alone when no controller is provided', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: SatisfactionPromptHost(
          surface: SatisfactionSurface.cloudChat,
          isQuiet: true,
          child: Text('chat'),
        ),
      ),
    );
    await tester.pump(_delay);
    expect(find.text('chat'), findsOneWidget);
  });
}
