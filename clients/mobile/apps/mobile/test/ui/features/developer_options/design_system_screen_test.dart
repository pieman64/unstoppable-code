import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/features/developer_options/views/fonts_screen.dart';
import 'package:mobile/ui/features/developer_options/views/typography_screen.dart';
import 'package:mobile/ui/features/developer_options/views/code_markdown_screen.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';
import 'package:mobile/ui/features/developer_options/views/search_field_screen.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

void main() {
  testWidgets('progress entry uses catalog icons', (tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light, home: const DesignSystemScreen()),
    );

    final row = find.byKey(const ValueKey('progress-button'));
    expect(
      find.descendant(of: row, matching: find.byType(CanopyIcon)),
      findsNWidgets(2),
    );
  });

  for (final dark in [false, true]) {
    testWidgets(
      'browse app bars and scroll behind chrome (${dark ? 'dark' : 'light'})',
      (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const DesignSystemScreen(),
          ),
        );
        await tester.tap(find.text('App bars'));
        await tester.pumpAndSettle();
        await tester.drag(
          find.byKey(const ValueKey('app-bar-preview-list')),
          const Offset(0, -300),
        );
        await tester.pumpAndSettle();
        expect(find.text('App bars'), findsOneWidget);
        await tester.tap(find.byTooltip('Preview options'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Example action'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.text('Design system'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('browse and try icon buttons (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.tap(find.text('Icon buttons'));
      await tester.pumpAndSettle();
      expect(find.text('Small'), findsOneWidget);
      expect(find.text('Medium'), findsOneWidget);
      await tester.tap(find.byTooltip('Add (small)'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings (medium)'));
      await tester.pumpAndSettle();
      expect(find.text('Button presses: 2'), findsOneWidget);
      for (final size in ['small', 'medium']) {
        final disabledIcon = tester.widget<CanopyIcon>(
          find.descendant(
            of: find.byTooltip('Delete unavailable ($size)'),
            matching: find.byType(CanopyIcon),
          ),
        );
        final colors = dark ? AppColors.dark : AppColors.light;
        expect(
          disabledIcon.tint,
          colors.foregroundSecondary.withValues(alpha: 0.5),
        );
      }
      await tester.tap(find.byTooltip('Delete unavailable (small)'));
      await tester.pumpAndSettle();
      expect(find.text('Button presses: 2'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('browse and try mini buttons (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.tap(find.byKey(const ValueKey('mini-buttons-button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mini-button-enabled')));
      await tester.pumpAndSettle();
      expect(find.text('Button presses: 1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('mini-button-disabled')));
      await tester.pumpAndSettle();
      expect(find.text('Button presses: 1'), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('Design system'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('browse and edit text fields (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.ensureVisible(
        find.byKey(const ValueKey('text-fields-button')),
      );
      await tester.tap(find.byKey(const ValueKey('text-fields-button')));
      await tester.pumpAndSettle();
      final field = find.byKey(const ValueKey('text-field-preview-empty'));
      await tester.enterText(field, 'release');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<EditableText>(
              find.descendant(of: field, matching: find.byType(EditableText)),
            )
            .controller
            .text,
        'release',
      );
      expect(find.text('Enter a number from 1 to 5.'), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('Design system'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('search field preview shows each state '
        '(${dark ? 'dark' : 'light'})', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      final entry = find.byKey(const ValueKey('search-field-button'));
      final glyphs = tester.widgetList<CanopyIcon>(
        find.descendant(of: entry, matching: find.byType(CanopyIcon)),
      );
      expect(glyphs, hasLength(2));
      // Untinted glyphs ignore the theme and render black on dark surfaces.
      final colors = dark ? AppColors.dark : AppColors.light;
      for (final glyph in glyphs) {
        expect(glyph.tint, colors.foregroundSecondary);
      }
      await tester.tap(entry);
      await tester.pumpAndSettle();

      EditableText editable(String state) => tester.widget<EditableText>(
        find.descendant(
          of: find.byKey(ValueKey('search-field-preview-$state')),
          matching: find.byType(EditableText),
        ),
      );
      Finder clearIn(String state) => find.descendant(
        of: find.byKey(ValueKey('search-field-preview-$state')),
        matching: find.byTooltip('Clear'),
      );
      expect(editable('empty').controller.text, isEmpty);
      expect(clearIn('empty'), findsNothing);
      expect(editable('text').controller.text, isNotEmpty);
      expect(clearIn('text'), findsOneWidget);
      expect(editable('focused').focusNode.hasFocus, isTrue);

      await tester.tap(clearIn('text'));
      await tester.pumpAndSettle();
      expect(editable('text').controller.text, isEmpty);
      expect(clearIn('text'), findsNothing);

      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('Design system'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('browse the settings list (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      final entry = find.byKey(const ValueKey('settings-list-button'));
      await tester.scrollUntilVisible(entry, 200);
      await tester.tap(entry);
      await tester.pumpAndSettle();

      expect(find.text('Section heading'), findsOneWidget);
      for (final title in [
        'Value',
        'Chevron',
        'Switch',
        'Menu',
        'Loading',
        'Disabled',
        'Destructive',
      ]) {
        expect(
          find.widgetWithText(CanopySettingsRow, title),
          findsOneWidget,
          reason: title,
        );
      }
      expect(find.text('reader@example.test'), findsOneWidget);

      await tester.tap(find.text('Switch'));
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);

      await tester.tap(find.text('Menu'));
      await tester.pumpAndSettle();
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is CanopyIcon && widget.glyph == CanopyGlyph.checkmark1,
        ),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(PopupMenuItem<String>, 'Large'));
      await tester.pumpAndSettle();
      expect(find.text('Large'), findsOneWidget);

      // The disabled row ignores taps; the destructive row uses the error ink.
      final disabled = tester.widget<CanopySettingsRow>(
        find.widgetWithText(CanopySettingsRow, 'Disabled'),
      );
      expect(disabled.enabled, isFalse);
      final destructive = tester.widget<Text>(find.text('Destructive'));
      expect(
        destructive.style?.color,
        (dark ? AppColors.dark : AppColors.light)['fg-destructive'],
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('browse colors and radii (${dark ? 'dark' : 'light'})', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      await tester.tap(find.text('Colors'));
      await tester.pumpAndSettle();
      expect(find.text('bg-base'), findsOneWidget);
      final swatch = tester.widget<Container>(
        find.byKey(const ValueKey('swatch-bg-base')),
      );
      expect(
        (swatch.decoration as BoxDecoration).color,
        (dark
            ? Brand.darkSemanticColors
            : Brand.lightSemanticColors)['bg-base'],
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Corner radii'));
      await tester.pumpAndSettle();
      expect(find.text('radius-sm'), findsOneWidget);
      expect(find.text('4 logical pixels'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('radius-full'), 250);
      expect(find.text('Pill / circle'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  for (final scale in [2.0, 3.2]) {
    testWidgets('search field preview fits 390px at ${scale}x text', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light, home: const SearchFieldScreen()),
      );
      await tester.pumpAndSettle();
      for (final state in ['empty', 'text', 'focused']) {
        await tester.scrollUntilVisible(
          find.byKey(ValueKey('search-field-preview-$state')),
          200,
          // The page list; each field holds its own horizontal scrollable.
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }
    });
  }

  testWidgets(
    'custom sample previews regular, emphasis and italic in both fonts',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.light, home: const FontsScreen()),
      );
      await tester.enterText(
        find.byKey(const ValueKey('font-sample-input')),
        'Example 123',
      );
      await tester.pump();
      for (final family in ['Inter', 'JetBrainsMono']) {
        final finder = find.byKey(ValueKey('$family-Italic emphasis · 450'));
        await tester.scrollUntilVisible(
          finder,
          250,
          scrollable: find
              .descendant(
                of: find.byKey(const ValueKey('design-reference-list')),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        final text = tester.widget<Text>(finder);
        expect(text.data, 'Example 123');
        expect(text.style?.fontFamily, family);
        expect(text.style?.fontStyle, FontStyle.italic);
        expect(text.style?.fontVariations?.single.value, 450);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('code and markdown preview renders the table sample', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light, home: const CodeMarkdownScreen()),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byType(MessageTableGrid),
      250,
      scrollable: find
          .descendant(
            of: find.byKey(const ValueKey('design-reference-list')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.byType(MessageTableGrid), findsOneWidget);
    expect(find.textContaining('Shape', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final dark in [false, true]) {
    testWidgets(
      'all reference content fits a phone at 2x text size in ${dark ? 'dark' : 'light'} mode',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        for (final screen in const [
          FontsScreen(),
          TypographyScreen(),
          CodeMarkdownScreen(),
        ]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: dark ? AppTheme.dark : AppTheme.light,
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: TextScaler.linear(2)),
                child: child!,
              ),
              home: screen,
            ),
          );
          await tester.pumpAndSettle();
          final scrollable = find
              .descendant(
                of: find.byKey(const ValueKey('design-reference-list')),
                matching: find.byType(Scrollable),
              )
              .first;
          while (tester
                  .state<ScrollableState>(scrollable)
                  .position
                  .extentAfter >
              0) {
            expect(tester.takeException(), isNull);
            await tester.drag(
              find.byKey(const ValueKey('design-reference-list')),
              const Offset(0, -500),
            );
            await tester.pumpAndSettle();
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        }
      },
    );
  }

  testWidgets('opens every font reference from the design system index', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light, home: const DesignSystemScreen()),
    );
    for (final (key, title) in [
      ('fonts-button', 'Fonts'),
      ('typography-button', 'Typography'),
      ('code-markdown-button', 'Code and markdown'),
    ]) {
      await tester.scrollUntilVisible(find.byKey(ValueKey(key)), 200);
      expect(
        find.text(title),
        findsOneWidget,
        reason: 'The design system must expose the $title reference.',
      );
      await tester.ensureVisible(find.byKey(ValueKey(key)));
      // Settle the last scroll so the tap uses the row's current position.
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(ValueKey(key)));
      await tester.pump();
      await tester.pumpAndSettle();
      expect(find.widgetWithText(CanopyAppBar, title), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pageBack();
      await tester.pumpAndSettle();
    }
    expect(find.byKey(const ValueKey('icons-button')), findsOneWidget);
    expect(find.text('Font licenses'), findsNothing);
  });

  for (final dark in [false, true]) {
    testWidgets(
      'CAN-3922 composer actions preview opens working sheets at 390 px and '
      '2x text (${dark ? 'dark' : 'light'})',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const DesignSystemScreen(),
          ),
        );
        // The preview's loading state spins forever: pump fixed frames.
        Future<void> frames() async {
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 500));
        }

        final entry = find.byKey(const ValueKey('composer-actions-button'));
        await tester.scrollUntilVisible(entry, 200);
        await tester.pumpAndSettle();
        await tester.tap(entry);
        await frames();

        await tester.tap(
          find.byKey(const ValueKey('preview-composer-actions')),
        );
        await frames();
        for (final id in [
          'attach-camera',
          'attach-library',
          'attach-files',
          'plugins',
          'plan',
        ]) {
          expect(
            tester.getSize(find.byKey(ValueKey('composer-action-$id'))).height,
            greaterThanOrEqualTo(48),
          );
        }
        await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
        await frames();
        final github = find.byKey(const ValueKey('composer-plugin-github'));
        expect(tester.widget<SwitchListTile>(github).value, isTrue);
        await tester.tap(github);
        await frames();
        expect(tester.widget<SwitchListTile>(github).value, isFalse);
        final linear = find.byKey(const ValueKey('composer-plugin-linear'));
        await tester.scrollUntilVisible(
          linear,
          48,
          duration: const Duration(milliseconds: 1),
          scrollable: find.descendant(
            of: find.byKey(const ValueKey('composer-plugins-list')),
            matching: find.byType(Scrollable),
          ),
        );
        await tester.ensureVisible(linear);
        await frames();
        await tester.tap(linear);
        await frames();
        expect(
          find.text('Could not change Linear. Try again.'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final dark in [false, true]) {
    testWidgets('Effort reference works at 390 px and 2x text '
        '(${dark ? 'dark' : 'light'})', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: const DesignSystemScreen(),
        ),
      );
      final entry = find.byKey(const ValueKey('effort-button'));
      await tester.scrollUntilVisible(entry, 200);
      await tester.pumpAndSettle();
      await tester.tap(entry);
      await tester.pumpAndSettle();
      expect(find.text('Effort'), findsWidgets);

      // The trigger opens the same panel in a sheet; picking a level updates
      // the example.
      final trigger = find.byKey(const ValueKey('effort-trigger-fast'));
      await tester.tap(trigger);
      await tester.pumpAndSettle();
      final sheet = find.byType(BottomSheet);
      final slider = find.descendant(
        of: sheet,
        matching: find.byKey(const ValueKey('effort-slider')),
      );
      final widget = tester.widget<Slider>(slider);
      widget.onChangeStart!(widget.value);
      widget.onChanged!(widget.max);
      widget.onChangeEnd!(widget.max);
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: sheet,
          matching: find.byKey(const ValueKey('effort-fast-mode')),
        ),
      );
      await tester.pumpAndSettle();
      Navigator.of(tester.element(sheet)).pop();
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: trigger, matching: find.text('Ultra')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: trigger,
          matching: find.byKey(const ValueKey('effort-trigger-bolt')),
        ),
        findsOneWidget,
      );

      // Ultra fast stays read-only.
      final ultra = find.byKey(const ValueKey('effort-example-ultra-fast'));
      await tester.scrollUntilVisible(ultra, 200);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.descendant(
            of: ultra,
            matching: find.byKey(const ValueKey('effort-fast-mode')),
          ),
          matching: find.byType(IconButton),
        ),
        findsNothing,
      );
      final single = find.byKey(const ValueKey('effort-example-single'));
      await tester.scrollUntilVisible(single, 200);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: single,
          matching: find.byKey(const ValueKey('effort-slider')),
        ),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });
  }
}
