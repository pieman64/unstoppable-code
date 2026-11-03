import 'dart:ui' show CheckedState;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_menu_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/ui/core/theme.dart';

Future<void> _pump(
  WidgetTester tester, {
  required String value,
  required ValueChanged<String> onSelected,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(
        body: Column(
          children: [
            const SizedBox(height: 100),
            CanopySettingsMenuRow<String>(
              glyph: CanopyGlyph.brightness,
              title: 'Appearance',
              value: value,
              options: const [
                ('system', 'System'),
                ('light', 'Light'),
                ('dark', 'Dark'),
              ],
              onSelected: onSelected,
            ),
          ],
        ),
      ),
    ),
  );
}

Finder _option(String label) =>
    find.widgetWithText(PopupMenuItem<String>, label);

Finder _checkmark() => find.byWidgetPredicate(
  (widget) => widget is CanopyIcon && widget.glyph == CanopyGlyph.checkmark1,
);

void main() {
  testWidgets('shows the current label and an up/down indicator', (
    tester,
  ) async {
    await _pump(tester, value: 'light', onSelected: (_) {});

    expect(find.text('Light'), findsOneWidget);
    for (final glyph in [
      CanopyGlyph.chevronTopSmall,
      CanopyGlyph.chevronDownSmall,
    ]) {
      expect(
        find.byWidgetPredicate((w) => w is CanopyIcon && w.glyph == glyph),
        findsOneWidget,
      );
    }
  });

  testWidgets('opens an anchored menu with one checkmark on the current '
      'option', (tester) async {
    await _pump(tester, value: 'light', onSelected: (_) {});

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();

    expect(_option('System'), findsOneWidget);
    expect(_option('Light'), findsOneWidget);
    expect(_option('Dark'), findsOneWidget);
    expect(_checkmark(), findsOneWidget);
    expect(
      find.descendant(of: _option('Light'), matching: _checkmark()),
      findsOneWidget,
    );
    // The menu opens below its row.
    expect(
      tester.getTopLeft(_option('System')).dy,
      greaterThanOrEqualTo(
        tester.getBottomLeft(find.byType(CanopySettingsRow)).dy,
      ),
    );
  });

  testWidgets('choosing another option reports it and closes the menu', (
    tester,
  ) async {
    final selected = <String>[];
    await _pump(tester, value: 'light', onSelected: selected.add);

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(_option('Dark'));
    await tester.pumpAndSettle();

    expect(selected, ['dark']);
    expect(_option('Dark'), findsNothing);
  });

  testWidgets('re-choosing the current option or dismissing reports nothing '
      'and returns focus to the row', (tester) async {
    final selected = <String>[];
    await _pump(tester, value: 'light', onSelected: selected.add);

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tap(_option('Light'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(195, 700));
    await tester.pumpAndSettle();

    expect(selected, isEmpty);
    expect(_option('System'), findsNothing);
    final focused = FocusManager.instance.primaryFocus;
    expect(focused?.debugLabel, 'settings menu row');
  });

  testWidgets('announces its current value and checked option', (tester) async {
    final semantics = tester.ensureSemantics();
    await _pump(tester, value: 'dark', onSelected: (_) {});

    final row = tester.getSemantics(find.text('Appearance'));
    expect(row.label, 'Appearance\nDark');
    expect(row.getSemanticsData().flagsCollection.isButton, isTrue);
    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();
    final option = tester
        .getSemantics(
          find.descendant(of: _option('Dark'), matching: find.text('Dark')),
        )
        .getSemanticsData();
    expect(option.flagsCollection.isChecked, CheckedState.isTrue);
    semantics.dispose();
  });

  // The pinned iOS accessibility bridge misplaces nodes whose traversal
  // parent differs from their hit-test parent, and keeps them after the menu
  // closes (flutter/flutter#182604).
  testWidgets('open options keep one semantics parent', (tester) async {
    final semantics = tester.ensureSemantics();
    await _pump(tester, value: 'dark', onSelected: (_) {});

    await tester.tap(find.text('Appearance'));
    await tester.pumpAndSettle();

    expect(find.text('System'), findsOneWidget);
    final reparented = <SemanticsData>[];
    void visit(SemanticsNode node) {
      final data = node.getSemanticsData();
      if (data.traversalChildIdentifier != null) reparented.add(data);
      node.visitChildren((child) {
        visit(child);
        return true;
      });
    }

    visit(
      tester
          .binding
          .renderViews
          .single
          .owner!
          .semanticsOwner!
          .rootSemanticsNode!,
    );
    expect(reparented, isEmpty);
    semantics.dispose();
  });
}
