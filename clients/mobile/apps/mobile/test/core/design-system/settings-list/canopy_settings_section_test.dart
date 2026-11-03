import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/theme.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  ThemeData? theme,
  double width = 390,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? AppTheme.light,
      home: Scaffold(
        body: ListView(padding: const EdgeInsets.all(16), children: [child]),
      ),
    ),
  );
}

void main() {
  group('CanopySettingsSection', () {
    testWidgets('draws a heading above a clipped raised card', (tester) async {
      await _pump(
        tester,
        const CanopySettingsSection(
          heading: 'Account',
          children: [CanopySettingsRow(title: 'Email')],
        ),
      );

      final heading = tester.widget<Text>(find.text('Account'));
      expect(heading.style?.color, AppColors.light.foregroundSecondary);
      final card = tester.widget<Material>(
        find
            .descendant(
              of: find.byType(CanopySettingsSection),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(card.color, AppColors.light.surfaceRaised);
      expect(card.clipBehavior, Clip.antiAlias);
      expect(
        card.shape,
        RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.xxl),
        ),
      );
      expect(
        tester.getTopLeft(find.text('Account')).dy,
        lessThan(tester.getTopLeft(find.text('Email')).dy),
      );
    });

    for (final dark in [false, true]) {
      testWidgets('uses a bold row-sized heading with an extra 2px inset '
          '(${dark ? 'dark' : 'light'})', (tester) async {
        final semantics = tester.ensureSemantics();
        final theme = dark ? AppTheme.dark : AppTheme.light;
        await _pump(
          tester,
          const CanopySettingsSection(
            heading: 'Account',
            children: [
              CanopySettingsRow(glyph: CanopyGlyph.email1, title: 'One'),
              CanopySettingsRow(glyph: CanopyGlyph.lock, title: 'Two'),
            ],
          ),
          theme: theme,
        );

        final sectionLeft = tester
            .getTopLeft(find.byType(CanopySettingsSection))
            .dx;
        expect(
          tester.getTopLeft(find.text('Account')).dx,
          sectionLeft + AppDimens.navRowLeadingInset + 2,
        );
        final headingStyle = tester.widget<Text>(find.text('Account')).style;
        final rowStyle = tester.widget<Text>(find.text('One')).style;
        expect(headingStyle?.fontSize, rowStyle?.fontSize);
        expect(headingStyle?.height, rowStyle?.height);
        expect(headingStyle?.fontWeight, FontWeight.bold);
        expect(headingStyle?.fontVariations, const [
          FontVariation('wght', 700),
        ]);
        expect(
          tester
              .getSemantics(find.text('Account'))
              .getSemanticsData()
              .flagsCollection
              .isHeader,
          isTrue,
        );
        expect(find.byType(Divider), findsNothing);
        expect(tester.takeException(), isNull);
        semantics.dispose();
      });
    }

    testWidgets('keeps icon-less rows together without separators', (
      tester,
    ) async {
      await _pump(
        tester,
        const CanopySettingsSection(
          heading: 'Keys',
          children: [
            CanopySettingsRow(title: 'One'),
            CanopySettingsRow(title: 'Two'),
            CanopySettingsRow(title: 'Three'),
          ],
        ),
      );

      expect(
        tester.getTopLeft(find.text('Keys')).dx,
        tester.getTopLeft(find.text('One')).dx + 2,
      );
      expect(find.byType(Divider), findsNothing);
      expect(
        tester.getBottomLeft(find.widgetWithText(CanopySettingsRow, 'One')).dy,
        tester.getTopLeft(find.widgetWithText(CanopySettingsRow, 'Two')).dy,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('wraps a bold heading on a narrow phone with enlarged text', (
      tester,
    ) async {
      tester.platformDispatcher.textScaleFactorTestValue = 3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await _pump(
        tester,
        const CanopySettingsSection(
          heading: 'Two-factor authentication',
          children: [CanopySettingsRow(title: 'Status')],
        ),
        width: 320,
      );
      expect(
        tester.getBottomLeft(find.text('Two-factor authentication')).dy,
        lessThan(tester.getTopLeft(find.text('Status')).dy),
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('CanopySettingsRow', () {
    testWidgets('keeps a 56 dp row and a trailing chevron', (tester) async {
      var taps = 0;
      await _pump(
        tester,
        CanopySettingsSection(
          children: [
            CanopySettingsRow(
              glyph: CanopyGlyph.lock,
              title: 'Login methods',
              trailing: const CanopySettingsChevron(),
              onTap: () => taps++,
            ),
          ],
        ),
      );

      expect(
        tester.getSize(find.byType(CanopySettingsRow)).height,
        AppDimens.settingsRowMinHeight,
      );
      expect(find.byType(CanopySettingsChevron), findsOneWidget);
      await tester.tap(find.text('Login methods'));
      expect(taps, 1);
    });

    testWidgets('a long value ellipsizes below the title, which never '
        'truncates', (tester) async {
      const title = 'Two-factor authentication status';
      const value = 'a-very-long-value-that-cannot-fit@example.test.invalid';
      await _pump(
        tester,
        const CanopySettingsSection(
          children: [
            CanopySettingsRow(
              glyph: CanopyGlyph.email1,
              title: title,
              value: CanopySettingsValue(value),
            ),
          ],
        ),
        width: 320,
      );

      final titleText = tester.widget<Text>(find.text(title));
      expect(titleText.maxLines, isNull);
      expect(titleText.overflow, isNull);
      final valueText = tester.widget<Text>(find.text(value));
      expect(valueText.maxLines, 1);
      expect(valueText.overflow, TextOverflow.ellipsis);
      expect(
        tester.getTopLeft(find.text(value)).dy,
        greaterThan(tester.getTopLeft(find.text(title)).dy),
      );
      expect(
        tester.getTopRight(find.text(value)).dx,
        lessThanOrEqualTo(320 - 16),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a short value sits on the title line at the trailing edge', (
      tester,
    ) async {
      await _pump(
        tester,
        const CanopySettingsSection(
          children: [
            CanopySettingsRow(
              title: 'API keys',
              value: CanopySettingsValue('2'),
            ),
          ],
        ),
      );

      expect(
        tester.getCenter(find.text('2')).dy,
        tester.getCenter(find.text('API keys')).dy,
      );
      expect(
        tester.getCenter(find.text('2')).dx,
        greaterThan(tester.getCenter(find.text('API keys')).dx),
      );
      final value = tester.widget<RichText>(
        find.descendant(of: find.text('2'), matching: find.byType(RichText)),
      );
      expect(value.text.style?.color, AppColors.light.foregroundSecondary);
    });

    testWidgets('a disabled row dims and ignores taps', (tester) async {
      var taps = 0;
      await _pump(
        tester,
        CanopySettingsSection(
          children: [
            CanopySettingsRow(
              title: 'Disabled',
              enabled: false,
              onTap: () => taps++,
            ),
          ],
        ),
      );

      await tester.tap(find.text('Disabled'));
      expect(taps, 0);
      final text = tester.widget<Text>(find.text('Disabled'));
      expect(text.style?.color, AppColors.light.disabledTint);
    });

    for (final dark in [false, true]) {
      testWidgets('a destructive row uses the error color '
          '(${dark ? 'dark' : 'light'})', (tester) async {
        var taps = 0;
        await _pump(
          tester,
          CanopySettingsSection(
            children: [
              CanopySettingsRow.destructive(
                glyph: CanopyGlyph.arrowBoxRight,
                title: 'Sign out',
                onTap: () => taps++,
              ),
            ],
          ),
          theme: dark ? AppTheme.dark : AppTheme.light,
        );

        final colors = dark ? AppColors.dark : AppColors.light;
        expect(
          tester.widget<Text>(find.text('Sign out')).style?.color,
          colors['fg-destructive'],
        );
        expect(find.byType(CanopySettingsChevron), findsNothing);
        await tester.tap(find.text('Sign out'));
        expect(taps, 1);
      });
    }

    testWidgets('announces its title and value as one node', (tester) async {
      final semantics = tester.ensureSemantics();
      await _pump(
        tester,
        CanopySettingsSection(
          children: [
            CanopySettingsRow(
              glyph: CanopyGlyph.shieldCheck,
              title: 'Two-factor authentication',
              value: const CanopySettingsValue('On'),
              trailing: const CanopySettingsChevron(),
              onTap: () {},
            ),
          ],
        ),
      );

      final node = tester.getSemantics(find.text('Two-factor authentication'));
      expect(node.label, 'Two-factor authentication\nOn');
      // Decorative glyphs are not announced as images.
      expect(node.getSemanticsData().flagsCollection.isImage, isFalse);
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(node.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(tester.getSemantics(find.text('On')), same(node));
      semantics.dispose();
    });

    testWidgets('announces tappable rows as buttons and read-only rows '
        'as text', (tester) async {
      final semantics = tester.ensureSemantics();
      await _pump(
        tester,
        CanopySettingsSection(
          children: [
            const CanopySettingsRow(
              title: 'Email',
              value: CanopySettingsValue('ada@example.com'),
            ),
            CanopySettingsRow(title: 'Paused', enabled: false, onTap: () {}),
            CanopySettingsRow.destructive(title: 'Sign out', onTap: () {}),
          ],
        ),
      );

      SemanticsData data(String title) =>
          tester.getSemantics(find.text(title)).getSemanticsData();
      expect(data('Email').flagsCollection.isButton, isFalse);
      expect(data('Email').hasAction(SemanticsAction.tap), isFalse);
      // A disabled row stays a button and is announced as disabled.
      expect(data('Paused').flagsCollection.isButton, isTrue);
      expect(data('Paused').flagsCollection.isEnabled, Tristate.isFalse);
      expect(data('Sign out').flagsCollection.isButton, isTrue);
      expect(data('Sign out').hasAction(SemanticsAction.tap), isTrue);
      semantics.dispose();
    });

    testWidgets('keeps the trailing action of a read-only row as its own '
        'button', (tester) async {
      final semantics = tester.ensureSemantics();
      var taps = 0;
      await _pump(
        tester,
        CanopySettingsSection(
          children: [
            CanopySettingsRow(
              title: 'CI token',
              subtitle: 'Manual',
              trailing: IconButton(
                tooltip: 'Revoke',
                onPressed: () => taps++,
                icon: const Icon(Icons.delete_outline),
              ),
            ),
          ],
        ),
      );

      final row = tester.getSemantics(find.text('CI token'));
      final action = tester.getSemantics(find.byTooltip('Revoke'));
      expect(action, isNot(same(row)));
      expect(row.label, 'CI token\nManual');
      expect(row.getSemanticsData().tooltip, isEmpty);
      expect(row.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
      final data = action.getSemanticsData();
      expect(data.tooltip, 'Revoke');
      expect(data.flagsCollection.isButton, isTrue);
      expect(data.hasAction(SemanticsAction.tap), isTrue);
      action.owner!.performAction(action.id, SemanticsAction.tap);
      expect(taps, 1);
      semantics.dispose();
    });

    testWidgets('a loading value is a still placeholder announced as Loading', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _pump(
        tester,
        const CanopySettingsSection(
          children: [
            CanopySettingsRow(
              title: 'API keys',
              value: CanopySettingsValue.loading(),
            ),
          ],
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(
        tester.getSemantics(find.text('API keys')).label,
        'API keys\nLoading',
      );
      semantics.dispose();
    });
  });
}
