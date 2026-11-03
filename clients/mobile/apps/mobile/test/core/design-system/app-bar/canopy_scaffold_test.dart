import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  for (final insets in [
    const EdgeInsets.only(right: 64),
    const EdgeInsets.only(left: 64),
  ]) {
    testWidgets('app bar uses each side inset once: $insets', (tester) async {
      tester.view.physicalSize = const Size(320, 626);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(
        left: insets.left,
        right: insets.right,
      );
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: const CanopyScaffold(
            appBar: CanopyAppBar(
              content: SizedBox.expand(key: ValueKey('title-slot')),
              leading: SizedBox.expand(key: ValueKey('leading-slot')),
              trailing: SizedBox.expand(key: ValueKey('trailing-slot')),
            ),
            body: SizedBox.expand(),
          ),
        ),
      );
      expect(
        tester.getRect(find.byKey(const ValueKey('title-slot'))).center.dx,
        (insets.left + 320 - insets.right) / 2,
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('title-slot'))).width,
        128,
      );
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('leading-slot'))).dx,
        insets.left + 8,
      );
      expect(
        tester.getTopRight(find.byKey(const ValueKey('trailing-slot'))).dx,
        320 - insets.right - 8,
      );
      expect(tester.takeException(), isNull);
    });
  }

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'two-line app bar keeps context and actions at text scale $scale',
      (tester) async {
        tester.view.physicalSize = const Size(320, 700);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: CanopyScaffold(
              appBar: CanopyAppBar(
                content: const Text(
                  'A long chat name that must stay on one line',
                ),
                subtitle: const Text(
                  'A long worktree description that must stay on one line',
                ),
                trailing: CanopyIconButton(
                  glyph: CanopyGlyph.plusSmall,
                  tooltip: 'Action',
                  onPressed: () {},
                ),
              ),
              body: const SizedBox.expand(),
            ),
          ),
        );
        final title = find.text('A long chat name that must stay on one line');
        final subtitle = find.text(
          'A long worktree description that must stay on one line',
        );
        expect(
          tester.getBottomLeft(title).dy,
          lessThanOrEqualTo(tester.getTopLeft(subtitle).dy),
        );
        expect(
          tester.getBottomLeft(subtitle).dy,
          lessThan(tester.getBottomLeft(find.byType(CanopyAppBar)).dy),
        );
        expect(find.byTooltip('Action').hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('app bar preserves square ink and themed Android controls', (
    tester,
  ) async {
    var pressed = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: CanopyScaffold(
          appBar: CanopyAppBar(
            content: const Text('Title'),
            trailing: CanopyIconButton(
              glyph: CanopyGlyph.plusSmall,
              tooltip: 'Action',
              onPressed: () => pressed = true,
            ),
          ),
          body: const SizedBox.expand(),
        ),
      ),
    );
    final ink = find.descendant(
      of: find.byType(CanopyIconButton),
      matching: find.byWidgetPredicate((widget) => widget is InkResponse),
    );
    final size = tester.getSize(ink);
    expect(size.width, size.height);
    await tester.tap(find.byTooltip('Action'));
    await tester.pumpAndSettle();
    expect(pressed, isTrue);
    final region = tester.widget<AnnotatedRegion<SystemUiOverlayStyle>>(
      find.byType(AnnotatedRegion<SystemUiOverlayStyle>).first,
    );
    expect(region.value.systemNavigationBarIconBrightness, Brightness.light);
  });

  testWidgets('app bar ends 8dp below the text and action row', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: CanopyScaffold(
          appBar: CanopyAppBar(
            content: const Text('Title'),
            trailing: CanopyIconButton(
              glyph: CanopyGlyph.plusSmall,
              tooltip: 'Action',
              onPressed: () {},
            ),
          ),
          body: const SizedBox.expand(),
        ),
      ),
    );

    final actionInk = find.descendant(
      of: find.byType(CanopyIconButton),
      matching: find.byWidgetPredicate((widget) => widget is InkResponse),
    );
    final barBottom = tester.getBottomLeft(find.byType(CanopyAppBar)).dy;
    final rowBottom = tester.getBottomLeft(actionInk).dy;

    expect(barBottom - rowBottom, 8);
  });

  testWidgets(
    'body fills screen, content clears safe areas and scrolls under centered chrome',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: CanopyScaffold(
            appBar: const CanopyAppBar(
              content: Text('Centered'),
              trailing: SizedBox(width: 48, height: 48),
            ),
            body: Builder(
              builder: (context) => ListView(
                padding: CanopyScaffold.contentPaddingOf(context),
                children: [
                  for (var i = 0; i < 30; i++)
                    SizedBox(height: 80, child: Text('Row $i')),
                ],
              ),
            ),
          ),
        ),
      );
      expect(
        tester.getRect(find.byType(ListView)),
        const Rect.fromLTWH(0, 0, 390, 844),
      );
      expect(tester.getTopLeft(find.text('Row 0')).dy, 103);
      expect(tester.getCenter(find.text('Centered')).dx, 195);
      final titleY = tester.getCenter(find.text('Centered')).dy;
      await tester.drag(find.byType(ListView), const Offset(0, -110));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('Row 0')).dy, lessThan(47));
      expect(tester.getCenter(find.text('Centered')).dy, titleY);
      await tester.drag(find.byType(ListView), const Offset(0, -4000));
      await tester.pumpAndSettle();
      expect(
        tester
            .getBottomLeft(
              find
                  .ancestor(
                    of: find.text('Row 29'),
                    matching: find.byType(SizedBox),
                  )
                  .first,
            )
            .dy,
        810,
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final (inset, actionExtent) in [(0.0, 48.0), (44.0, 64.0)]) {
    testWidgets('contentWidth matches the laid-out content slot '
        '(inset $inset, actionExtent $actionExtent)', (tester) async {
      tester.view.physicalSize = const Size(390, 700);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = FakeViewPadding(left: inset, top: 20);
      addTearDown(tester.view.reset);
      late double contentWidth;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Builder(
            builder: (context) {
              final appBar = CanopyAppBar(
                actionExtent: actionExtent,
                content: const SizedBox.expand(key: ValueKey('content')),
              );
              contentWidth = appBar.contentWidth(context);
              return CanopyScaffold(
                appBar: appBar,
                body: const SizedBox.expand(),
              );
            },
          ),
        ),
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('content'))).width,
        contentWidth,
      );
    });
  }
}
