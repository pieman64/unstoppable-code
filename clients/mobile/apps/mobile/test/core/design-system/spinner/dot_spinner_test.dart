import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';

void main() {
  Widget host(Widget child) => MaterialApp(
    theme: AppTheme.light,
    home: Scaffold(body: Center(child: child)),
  );

  testWidgets('animates continuously while motion is allowed', (tester) async {
    await tester.pumpWidget(host(const ThinkingSpinner()));
    await tester.pump();
    expect(find.byType(DotSpinner), findsOneWidget);
    // An always-on spinner keeps scheduling frames.
    expect(tester.hasRunningAnimations, isTrue);
    // Bounded pumps advance without throwing.
    await tester.pump(const Duration(milliseconds: 450));
    await tester.pump(const Duration(milliseconds: 450));
    expect(tester.takeException(), isNull);
  });

  testWidgets('isolates its per-frame repaint behind a RepaintBoundary', (
    tester,
  ) async {
    // An always-on spinner in a list row must not force the whole screen
    // (and the app bar blur over it) to re-rasterize on every tick.
    await tester.pumpWidget(host(const ThinkingSpinner()));
    await tester.pump();
    expect(
      find.descendant(
        of: find.byType(DotSpinner),
        matching: find.byType(RepaintBoundary),
      ),
      findsOneWidget,
    );
  });

  testWidgets('static working grids settle with motion enabled', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(host(const ThinkingSpinner(animate: false)));
    await tester.pumpAndSettle();
    expect(find.byType(DotSpinner), findsOneWidget);
    expect(find.bySemanticsLabel('In progress'), findsOneWidget);
    expect(tester.getSize(find.byType(DotSpinner)), const Size(12, 12));
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pump(const Duration(seconds: 60));
    expect(tester.binding.hasScheduledFrame, isFalse);
    semantics.dispose();
  });

  testWidgets('switching animation policy stops and resumes the clock', (
    tester,
  ) async {
    await tester.pumpWidget(host(const ThinkingSpinner()));
    expect(tester.hasRunningAnimations, isTrue);
    await tester.pumpWidget(host(const ThinkingSpinner(animate: false)));
    await tester.pumpAndSettle();
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pumpWidget(host(const ThinkingSpinner()));
    expect(tester.hasRunningAnimations, isTrue);

    tester.binding.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue,
    );
    await tester.pumpAndSettle();
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pumpWidget(host(const ThinkingSpinner(animate: false)));
    tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
    await tester.pumpAndSettle();
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pumpWidget(host(const ThinkingSpinner()));
    expect(tester.hasRunningAnimations, isTrue);
  });

  testWidgets('all variants build at their footprint size', (tester) async {
    await tester.pumpWidget(
      host(
        const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            ThinkingSpinner(size: 12),
            LoadingSpinner(size: 16),
            RunSpinner(size: 18),
          ],
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(DotSpinner), findsNWidgets(3));
    expect(tester.getSize(find.byType(DotSpinner).first), const Size(12, 12));
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders a static frame and settles under reduce-motion', (
    tester,
  ) async {
    tester.binding.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(
      tester.binding.platformDispatcher.clearAccessibilityFeaturesTestValue,
    );

    await tester.pumpWidget(host(const ThinkingSpinner()));
    // Settling proves the animation controller is stopped.
    await tester.pumpAndSettle();
    expect(find.byType(DotSpinner), findsOneWidget);
    expect(tester.hasRunningAnimations, isFalse);
  });
}
