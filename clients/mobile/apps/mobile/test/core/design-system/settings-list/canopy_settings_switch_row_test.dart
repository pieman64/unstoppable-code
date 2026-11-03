import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_switch_row.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';

Future<void> _pump(
  WidgetTester tester, {
  required bool value,
  required ValueChanged<bool>? onChanged,
  ThemeData? theme,
}) => tester.pumpWidget(
  MaterialApp(
    theme: theme ?? AppTheme.light,
    home: Scaffold(
      body: CanopySettingsSwitchRow(
        glyph: CanopyGlyph.bell,
        title: 'Push notifications',
        value: value,
        onChanged: onChanged,
      ),
    ),
  ),
);

void main() {
  testWidgets('tapping the row or the switch changes it once', (tester) async {
    final changes = <bool>[];
    await _pump(tester, value: true, onChanged: changes.add);

    await tester.tap(find.text('Push notifications'));
    await tester.pump();
    expect(changes, [false]);

    await tester.tap(find.byType(Switch));
    await tester.pump();
    expect(changes, [false, false]);
  });

  testWidgets('a null onChanged disables the row and the switch', (
    tester,
  ) async {
    await _pump(tester, value: true, onChanged: null);

    await tester.tap(find.text('Push notifications'));
    await tester.pump();
    expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);
  });

  for (final dark in [false, true]) {
    testWidgets('uses the brand colors (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      await _pump(
        tester,
        value: true,
        onChanged: (_) {},
        theme: dark ? AppTheme.dark : AppTheme.light,
      );

      final colors = dark ? AppColors.dark : AppColors.light;
      final toggle = tester.widget<Switch>(find.byType(Switch));
      expect(toggle.activeTrackColor, colors.accent);
      expect(toggle.activeThumbColor, colors.onAccent);
    });
  }

  testWidgets('screen readers find one toggle carrying the title', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _pump(tester, value: false, onChanged: (_) {});

    final node = tester.getSemantics(find.text('Push notifications'));
    expect(tester.getSemantics(find.byType(Switch)), same(node));
    final data = node.getSemanticsData();
    expect(data.label, 'Push notifications');
    expect(data.flagsCollection.isToggled, Tristate.isFalse);
    // The row's tap toggles the switch, so it adds no button role.
    expect(data.flagsCollection.isButton, isFalse);
    semantics.dispose();
  });

  testWidgets('a disabled row stays one labelled toggle with no tap action', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _pump(tester, value: true, onChanged: null);

    final node = tester.getSemantics(find.text('Push notifications'));
    expect(
      tester.getSemantics(find.byType(Switch)),
      same(node),
      reason: 'the disabled switch still merges into the row',
    );
    final data = node.getSemanticsData();
    expect(data.label, 'Push notifications');
    expect(data.flagsCollection.isToggled, Tristate.isTrue);
    expect(data.flagsCollection.isEnabled, Tristate.isFalse);
    expect(data.hasAction(SemanticsAction.tap), isFalse);
    semantics.dispose();
  });
}
