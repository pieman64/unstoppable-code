import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';

Widget _host(Widget field, {bool dark = false, double textScale = 1}) =>
    MaterialApp(
      theme: dark ? AppTheme.dark : AppTheme.light,
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: Scaffold(
            body: Padding(padding: const EdgeInsets.all(16), child: field),
          ),
        ),
      ),
    );

final _clear = find.byTooltip('Clear');

InputDecoration _decoration(WidgetTester tester) =>
    tester.widget<InputDecorator>(find.byType(InputDecorator)).decoration;

void main() {
  late TextEditingController controller;

  setUp(() => controller = TextEditingController());
  tearDown(() => controller.dispose());

  for (final dark in [false, true]) {
    testWidgets(
      'filled, borderless and secondary (${dark ? 'dark' : 'light'})',
      (tester) async {
        await tester.pumpWidget(
          _host(
            CanopySearchField(controller: controller, hintText: 'Search'),
            dark: dark,
          ),
        );
        final colors = dark ? AppColors.dark : AppColors.light;

        final decoration = _decoration(tester);
        expect(decoration.filled, isTrue);
        expect(decoration.fillColor, colors.surfaceRaised);
        // Hover blends the fill over itself, so the surface never changes.
        expect(decoration.hoverColor, isNot(Colors.transparent));
        expect(decoration.hoverColor, decoration.fillColor);
        for (final border in [
          decoration.border,
          decoration.enabledBorder,
          decoration.focusedBorder,
          decoration.disabledBorder,
        ]) {
          expect(
            border,
            isA<OutlineInputBorder>()
                .having((b) => b.borderSide, 'side', BorderSide.none)
                .having(
                  (b) => b.borderRadius,
                  'radius',
                  BorderRadius.circular(AppRadii.lg),
                ),
          );
        }

        final magnifier = find.byWidgetPredicate(
          (widget) =>
              widget is CanopyIcon &&
              widget.glyph == CanopyGlyph.magnifyingGlass,
        );
        expect(
          tester.widget<CanopyIcon>(magnifier).tint,
          colors.foregroundSecondary,
        );
        expect(tester.getSize(magnifier), const Size.square(20));
        expect(
          tester
              .renderObject<RenderParagraph>(find.text('Search'))
              .text
              .style
              ?.color,
          colors.foregroundSecondary,
        );
        expect(_clear, findsNothing);
      },
    );

    testWidgets('focus tints the fill and keeps it borderless '
        '(${dark ? 'dark' : 'light'})', (tester) async {
      await tester.pumpWidget(
        _host(
          CanopySearchField(controller: controller, hintText: 'Search'),
          dark: dark,
        ),
      );
      final colors = dark ? AppColors.dark : AppColors.light;
      await tester.tap(find.byType(TextField));
      await tester.pump();

      final decoration = _decoration(tester);
      expect(decoration.fillColor, isNot(colors.surfaceRaised));
      expect(
        decoration.fillColor,
        Color.alphaBlend(
          colors.focus.withValues(alpha: 0.16),
          colors.surfaceRaised,
        ),
      );
      expect(decoration.hoverColor, decoration.fillColor);
      expect(decoration.focusedBorder!.borderSide, BorderSide.none);
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).cursorColor,
        colors.focus,
      );

      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      expect(_decoration(tester).fillColor, colors.surfaceRaised);
    });
  }

  testWidgets('Clear appears with text, empties it and reports once', (
    tester,
  ) async {
    final changes = <String>[];
    final submits = <String>[];
    await tester.pumpWidget(
      _host(
        CanopySearchField(
          controller: controller,
          hintText: 'Search',
          onChanged: changes.add,
          onSubmitted: submits.add,
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'staging');
    await tester.pump();
    expect(changes, ['staging']);
    expect(_clear, findsOneWidget);
    expect(
      tester.widget<CanopyIconButton>(find.byType(CanopyIconButton)).glyph,
      CanopyGlyph.crossSmall,
    );
    final target = tester.getSize(_clear);
    expect(target.width, greaterThanOrEqualTo(48));
    expect(target.height, greaterThanOrEqualTo(48));

    await tester.tap(_clear);
    await tester.pump();
    expect(controller.text, isEmpty);
    expect(changes, ['staging', '']);
    expect(submits, isEmpty);
    expect(_clear, findsNothing);
  });

  testWidgets('Clear is announced as a button named Clear', (tester) async {
    final handle = tester.ensureSemantics();
    controller.text = 'staging';
    await tester.pumpWidget(
      _host(CanopySearchField(controller: controller, hintText: 'Search')),
    );

    expect(
      tester.getSemantics(find.byType(IconButton)),
      isSemantics(
        tooltip: 'Clear',
        isButton: true,
        isEnabled: true,
        hasTapAction: true,
      ),
    );
    handle.dispose();
  });

  testWidgets('Clear follows programmatic and prepopulated text', (
    tester,
  ) async {
    controller.text = 'deploy';
    await tester.pumpWidget(
      _host(CanopySearchField(controller: controller, hintText: 'Search')),
    );
    expect(_clear, findsOneWidget);

    controller.clear();
    await tester.pump();
    expect(_clear, findsNothing);

    controller.text = 'notes';
    await tester.pump();
    expect(_clear, findsOneWidget);
  });

  testWidgets('a replaced controller drives Clear and the old one does not', (
    tester,
  ) async {
    final replacement = TextEditingController();
    addTearDown(replacement.dispose);
    await tester.pumpWidget(
      _host(CanopySearchField(controller: controller, hintText: 'Search')),
    );
    await tester.pumpWidget(
      _host(CanopySearchField(controller: replacement, hintText: 'Search')),
    );

    controller.text = 'stale';
    await tester.pump();
    expect(_clear, findsNothing);

    replacement.text = 'fresh';
    await tester.pump();
    expect(_clear, findsOneWidget);
    await tester.tap(_clear);
    await tester.pump();
    expect(replacement.text, isEmpty);
    expect(controller.text, 'stale');
  });

  testWidgets('the keyboard search action submits the text', (tester) async {
    final submits = <String>[];
    await tester.pumpWidget(
      _host(
        CanopySearchField(
          controller: controller,
          hintText: 'Search',
          onSubmitted: submits.add,
        ),
      ),
    );
    expect(
      tester.widget<TextField>(find.byType(TextField)).textInputAction,
      TextInputAction.search,
    );

    await tester.enterText(find.byType(TextField), 'deploy');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump();
    expect(submits, ['deploy']);
  });

  testWidgets('autofocus focuses the field', (tester) async {
    await tester.pumpWidget(
      _host(
        CanopySearchField(
          controller: controller,
          hintText: 'Search',
          autofocus: true,
        ),
      ),
    );
    await tester.pump();
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).focusNode.hasFocus,
      isTrue,
    );
  });

  testWidgets('leaves the caller-owned controller usable after unmount', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(CanopySearchField(controller: controller, hintText: 'Search')),
    );
    await tester.pumpWidget(const SizedBox());

    controller.text = 'still usable';
    expect(controller.text, 'still usable');
  });

  for (final scale in [1.0, 2.0, 3.0, 3.2]) {
    testWidgets('fits a 390px phone at ${scale}x text', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        _host(
          CanopySearchField(
            controller: controller,
            hintText: 'Search pipelines',
          ),
          textScale: scale,
        ),
      );
      expect(tester.takeException(), isNull);

      await tester.enterText(find.byType(TextField), 'staging deploy notes');
      await tester.pump();
      expect(_clear, findsOneWidget);
      expect(
        tester.getRect(_clear).right,
        lessThanOrEqualTo(tester.getRect(find.byType(TextField)).right),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
