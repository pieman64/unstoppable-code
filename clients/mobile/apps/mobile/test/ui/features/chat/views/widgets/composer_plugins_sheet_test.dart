import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import 'package:mobile/ui/core/chat/widgets/composer_plugins_sheet.dart';

void main() {
  final items = [
    for (var i = 0; i < 12; i++)
      ComposerPluginItem(
        kind: ComposerPluginKind.plugin,
        ref: {'marketplaceId': 'market', 'pluginName': 'plugin-$i'},
        name: 'Plugin $i',
        description: 'Does useful work number $i',
      ),
  ];

  Future<void> open(
    WidgetTester tester, {
    required double textScale,
    bool fail = false,
    Future<Map<String, Object?>> Function(Map<String, Object?> next)? save,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(bottom: 34);
    addTearDown(tester.view.reset);
    final source = ComposerPluginsSource(
      providerType: () => null,
      loadCatalog: () async => ComposerPluginCatalog(items: items),
      loadSelections: () async =>
          fail ? throw StateError('unknown') : const <String, Object?>{},
      save: save ?? (next) async => next,
      selectedCount: () => null,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showComposerPluginsSheet(context, source),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  // The sheet adds the 34px inset once, below its own 16px bottom padding.
  const lastBottom = 844 - 34 - 16;

  for (final textScale in [1.0, 2.0]) {
    testWidgets('the last plugin row scrolls clear of the bottom system '
        'inset at ${textScale}x text', (tester) async {
      await open(tester, textScale: textScale);
      final last = find.byKey(
        ValueKey('composer-plugin-${items.last.key}'),
        skipOffstage: false,
      );
      await tester.scrollUntilVisible(
        last,
        200,
        scrollable: find.descendant(
          of: find.byKey(const ValueKey('composer-plugins-list')),
          matching: find.byType(Scrollable),
        ),
      );
      await tester.drag(
        find.byKey(const ValueKey('composer-plugins-sheet')),
        const Offset(0, -2000),
      );
      await tester.pumpAndSettle();

      final rect = tester.getRect(last);
      expect(rect.bottom, lastBottom);
      expect(rect.height, greaterThanOrEqualTo(48));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Retry stays above the bottom system inset', (tester) async {
    await open(tester, textScale: 1, fail: true);
    final retry = tester.getRect(
      find.byKey(const ValueKey('composer-plugins-retry')),
    );
    expect(retry.bottom, lastBottom);
    expect(tester.takeException(), isNull);
  });

  group('CAN-3922 a failed toggle', () {
    String message(int i) => 'Could not change Plugin $i. Try again.';
    Finder row(int i) =>
        find.byKey(ValueKey('composer-plugin-${items[i].key}'));
    bool on(WidgetTester tester, int i) =>
        tester.widget<SwitchListTile>(row(i)).value;

    for (final textScale in [1.0, 2.0]) {
      testWidgets('shows its error in place of its own row label at '
          '${textScale}x text, and a retry clears it', (tester) async {
        final semantics = tester.ensureSemantics();
        final failing = {items[3].key, items[1].key};
        await open(
          tester,
          textScale: textScale,
          save: (next) async {
            final refs = (next['pluginRefs']! as List).cast<Map>();
            for (final item in items) {
              if (failing.contains(item.key) &&
                  refs.any(
                    (ref) => ref['pluginName'] == item.ref['pluginName'],
                  )) {
                throw StateError('rejected');
              }
            }
            return next;
          },
        );
        final scrollable = find.descendant(
          of: find.byKey(const ValueKey('composer-plugins-list')),
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(row(3), 48, scrollable: scrollable);
        await tester.ensureVisible(row(3));
        await tester.pumpAndSettle();
        await tester.tap(row(3));
        await tester.pumpAndSettle();

        expect(on(tester, 3), isFalse);
        // The error takes the place of the row's label; its detail stays and
        // no line or height is added.
        expect(find.text(message(3)), findsOneWidget);
        expect(
          find.descendant(
            of: find.byWidget(tester.widget<SwitchListTile>(row(3)).title!),
            matching: find.text(message(3)),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: row(3), matching: find.text('Plugin 3')),
          findsNothing,
        );
        expect(
          find.descendant(
            of: row(3),
            matching: find.text('Does useful work number 3'),
          ),
          findsOneWidget,
        );
        expect(tester.getSize(row(3)).height, tester.getSize(row(4)).height);
        expect(
          find.descendant(
            of: row(3),
            matching: find.byWidgetPredicate(
              (widget) => widget is Tooltip && widget.message == message(3),
            ),
          ),
          findsOneWidget,
        );
        expect(tester.getSemantics(row(3)).label, contains(message(3)));
        expect(
          find.descendant(
            of: row(3),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is Semantics && widget.properties.liveRegion == true,
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row(4),
            matching: find.text('Does useful work number 4'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);

        // A failure on another row moves the error there.
        await tester.scrollUntilVisible(row(1), -48, scrollable: scrollable);
        await tester.ensureVisible(row(1));
        await tester.pumpAndSettle();
        await tester.tap(row(1));
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: row(1), matching: find.text(message(1))),
          findsOneWidget,
        );
        expect(find.text(message(3)), findsNothing);

        // A retry that succeeds clears the error and keeps the row on.
        failing.remove(items[1].key);
        await tester.tap(row(1));
        await tester.pumpAndSettle();
        expect(on(tester, 1), isTrue);
        expect(find.text(message(1)), findsNothing);
        expect(
          find.descendant(of: row(1), matching: find.text('Plugin 1')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row(1),
            matching: find.text('Does useful work number 1'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        semantics.dispose();
      });
    }
  });
}
