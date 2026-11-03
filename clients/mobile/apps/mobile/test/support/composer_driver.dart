import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';

/// Changes an independent control from the main composer. `effort` moves one
/// level up on the Effort sheet, and `fast` toggles Fast mode there.
Future<void> chooseComposerOption(WidgetTester tester, String option) async {
  if (option == 'plan') return toggleComposerPlan(tester);
  if (option == 'fast') return toggleComposerFast(tester);
  if (option == 'effort') {
    await openEffortSheet(tester);
    final panel = tester.widget<CanopyEffortPanel>(
      find.byType(CanopyEffortPanel),
    );
    final next = panel.levels.indexOf(panel.level) + 1;
    await landEffortSlider(tester, panel.levels[next % panel.levels.length]);
    return closeEffortSheet(tester);
  }
  final control = find.byKey(ValueKey('composer-$option'));
  await tester.ensureVisible(control);
  await tester.tap(control);
  await tester.pumpAndSettle();
}

/// Opens the Effort sheet from the composer's effort control.
Future<void> openEffortSheet(WidgetTester tester) async {
  final trigger = find.byKey(const ValueKey('composer-thinking'));
  await tester.ensureVisible(trigger);
  await tester.tap(trigger);
  await tester.pumpAndSettle();
}

/// Ends a slider drag on [level] in the open Effort sheet.
Future<void> landEffortSlider(WidgetTester tester, String level) async {
  final panel = tester.widget<CanopyEffortPanel>(
    find.byType(CanopyEffortPanel),
  );
  final index = panel.levels.indexOf(level).toDouble();
  expect(index, isNonNegative, reason: '$level is offered');
  final slider = tester.widget<Slider>(
    find.byKey(const ValueKey('effort-slider')),
  );
  slider.onChangeStart?.call(slider.value);
  slider.onChanged!(index);
  slider.onChangeEnd!(index);
  await tester.pumpAndSettle();
}

/// Closes the open Effort sheet.
Future<void> closeEffortSheet(WidgetTester tester) async {
  final sheet = find.byType(BottomSheet);
  if (!tester.any(sheet)) return;
  Navigator.of(tester.element(sheet)).pop();
  await tester.pumpAndSettle();
}

/// The open Effort sheet's heading, such as `Effort  High`.
String effortHeadingText(WidgetTester tester) => tester
    .widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey('effort-level')),
        matching: find.byType(Text),
      ),
    )
    .textSpan!
    .toPlainText();

/// Starts a real drag at the open Effort sheet's weakest level and holds it
/// on [level]. Release it with [TestGesture.up].
Future<TestGesture> holdEffortDrag(WidgetTester tester, String level) async {
  final rect = tester.getRect(find.byKey(const ValueKey('effort-slider')));
  final label = 'Effort  ${canopyEffortLabel(level)}';
  final start = Offset(rect.left + 2, rect.center.dy);
  final gesture = await tester.startGesture(start);
  await gesture.moveTo(start + const Offset(40, 0));
  await gesture.moveTo(start);
  await tester.pump();
  for (var x = rect.left + 2; x < rect.right; x += 2) {
    await gesture.moveTo(Offset(x, rect.center.dy));
    await tester.pump();
    if (effortHeadingText(tester) == label) return gesture;
  }
  fail('the drag never reached $level');
}

/// Picks [level] on the Effort sheet, then closes it.
Future<void> chooseComposerEffort(WidgetTester tester, String level) async {
  await openEffortSheet(tester);
  await landEffortSlider(tester, level);
  await closeEffortSheet(tester);
}

/// Toggles Fast mode on the Effort sheet, then closes it.
Future<void> toggleComposerFast(WidgetTester tester) async {
  await openEffortSheet(tester);
  await tester.tap(find.byKey(const ValueKey('effort-fast-mode')));
  await tester.pumpAndSettle();
  await closeEffortSheet(tester);
}

// The `+` helpers pump fixed frames rather than settling, so they also work
// while a send spinner animates.
const _sheetTransition = Duration(milliseconds: 400);

/// Opens the composer's `+` sheet.
Future<void> openComposerActions(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('composer-actions')));
  await tester.pump();
  await tester.pump(_sheetTransition);
}

/// Closes an open `+` sheet.
Future<void> closeComposerActions(WidgetTester tester) async {
  final sheet = find.byType(BottomSheet);
  if (!tester.any(sheet)) return;
  Navigator.of(tester.element(sheet)).pop();
  await tester.pump();
  await tester.pump(_sheetTransition);
}

/// The `+` sheet's attachment source rows, in their fixed order.
const composerAttachRowKeys = [
  'composer-action-attach-camera',
  'composer-action-attach-library',
  'composer-action-attach-files',
];

/// Whether the `+` sheet offers its attachment source rows, and whether they
/// are enabled; null when the rows are absent, including when the composer
/// shows no `+` because it has nothing to offer. The rows share one state.
/// Leaves the sheet closed.
Future<bool?> composerAttachRowEnabled(WidgetTester tester) async {
  if (!tester.any(find.byKey(const ValueKey('composer-actions')))) return null;
  await openComposerActions(tester);
  final rows = [
    for (final key in composerAttachRowKeys) find.byKey(ValueKey(key)),
  ];
  final states = rows.any(tester.any)
      ? {for (final row in rows) tester.widget<ListTile>(row).enabled}
      : const <bool>{};
  expect(states.length, lessThanOrEqualTo(1));
  await closeComposerActions(tester);
  return states.singleOrNull;
}

/// Toggles Plan mode through its + menu row.
Future<void> toggleComposerPlan(WidgetTester tester) async {
  await openComposerActions(tester);
  await tester.tap(find.byKey(const ValueKey('composer-action-plan')));
  await tester.pump();
  await tester.pump(_sheetTransition);
}
