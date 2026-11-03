import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action_sheet.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_plugins_sheet.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  Widget app(Widget home) => MaterialApp(
    theme: AppTheme.light,
    home: Scaffold(body: home),
  );

  testWidgets('a chosen action runs after its sheet has closed', (
    tester,
  ) async {
    final runs = <String>[];
    await tester.pumpWidget(
      app(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showCanopyComposerActionSheet(
              context,
              actions: [
                CanopyComposerSheetAction(
                  id: 'attach',
                  glyph: CanopyGlyph.pageAttachment,
                  label: 'Files',
                  enabled: false,
                  detail: 'Up to 8 attachments per message',
                  onSelected: () => runs.add('attach'),
                ),
                CanopyComposerSheetAction(
                  id: 'plugins',
                  glyph: CanopyGlyph.puzzle,
                  label: 'Plugins',
                  count: 3,
                  onSelected: () => runs.add('plugins'),
                ),
                CanopyComposerSheetAction(
                  id: 'none',
                  glyph: CanopyGlyph.map,
                  label: 'Zero count',
                  count: 0,
                  onSelected: () {},
                ),
              ],
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Up to 8 attachments per message'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('0'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('composer-action-attach')));
    await tester.pumpAndSettle();
    expect(runs, isEmpty);
    expect(find.byType(BottomSheet), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
    // The sheet's route is popped before the action runs, so a follow-up
    // sheet replaces it.
    await tester.pump();
    expect(runs, ['plugins']);
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
  });

  for (final textScale in [1.0, 2.0]) {
    testWidgets('the last action row stays above the bottom system inset '
        'at ${textScale}x text', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(bottom: 34);
      addTearDown(tester.view.reset);
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
                onPressed: () => showCanopyComposerActionSheet(
                  context,
                  actions: [
                    for (final id in ['attach', 'plugins', 'plan'])
                      CanopyComposerSheetAction(
                        id: id,
                        glyph: CanopyGlyph.puzzle,
                        label: 'Action $id',
                        onSelected: () {},
                      ),
                  ],
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The sheet adds the inset once, below its own 8px bottom padding.
      final last = tester.getRect(
        find.byKey(const ValueKey('composer-action-plan')),
      );
      expect(last.bottom, 844 - 34 - 8);
      expect(last.height, greaterThanOrEqualTo(48));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('the plugins sheet shows each state and holds rows while '
      'a write is in flight', (tester) async {
    final toggled = <String>[];
    var retries = 0;
    Future<void> pump(
      CanopyPluginsSheetState state, {
      bool saving = false,
      String? error,
      bool empty = false,
    }) => tester.pumpWidget(
      app(
        CanopyComposerPluginsSheet(
          state: state,
          onToggle: toggled.add,
          onRetry: () => retries++,
          sections: [
            (
              title: 'Plugins',
              rows: [
                if (!empty)
                  CanopyPluginToggle(
                    id: 'github',
                    label: 'GitHub',
                    selected: false,
                    saving: saving,
                    error: error,
                  ),
              ],
            ),
          ],
        ),
      ),
    );

    await pump(CanopyPluginsSheetState.loading);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await pump(CanopyPluginsSheetState.failed);
    await tester.tap(find.byKey(const ValueKey('composer-plugins-retry')));
    expect(retries, 1);

    await pump(CanopyPluginsSheetState.ready, empty: true);
    expect(
      find.text('No plugins are available for this chat.'),
      findsOneWidget,
    );

    await pump(CanopyPluginsSheetState.ready, saving: true, error: 'Nope');
    expect(find.text('Nope'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('composer-plugin-github')));
    expect(toggled, isEmpty);

    await pump(CanopyPluginsSheetState.ready);
    await tester.tap(find.byKey(const ValueKey('composer-plugin-github')));
    expect(toggled, ['github']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an unavailable row shows its reason in place of its detail', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final toggled = <String>[];
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      app(
        CanopyComposerPluginsSheet(
          state: CanopyPluginsSheetState.ready,
          onToggle: toggled.add,
          onRetry: () {},
          sections: [
            (
              title: 'Plugins',
              rows: [
                const CanopyPluginToggle(
                  id: 'off',
                  label: 'Codex tools',
                  detail: 'Codex only',
                  selected: false,
                  enabled: false,
                  unavailableReason: 'Unsupported by this provider',
                ),
                const CanopyPluginToggle(
                  id: 'on',
                  label: 'Codex review',
                  detail: 'Codex only',
                  selected: true,
                  unavailableReason: 'Unsupported by this provider',
                ),
              ],
            ),
          ],
        ),
      ),
    );

    expect(find.text('Codex only'), findsNothing);
    expect(find.text('Unsupported by this provider'), findsNWidgets(2));
    expect(
      tester.getSemantics(find.byKey(const ValueKey('composer-plugin-off'))),
      isSemantics(
        label: 'Codex tools\nUnsupported by this provider',
        hasEnabledState: true,
        isEnabled: false,
      ),
    );
    await tester.tap(find.byKey(const ValueKey('composer-plugin-off')));
    await tester.tap(find.byKey(const ValueKey('composer-plugin-on')));
    expect(toggled, ['on']);
    for (final id in ['off', 'on']) {
      expect(
        tester.getSize(find.byKey(ValueKey('composer-plugin-$id'))).height,
        greaterThanOrEqualTo(48),
      );
    }
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });

  testWidgets('a failed row shows its error in place of its label, keeping '
      'its detail and putting the error in its tooltip and accessible name', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final semantics = tester.ensureSemantics();
    const error = 'Could not change Codex review. Try again.';
    const reason = 'Unsupported by this provider';
    CanopyPluginToggle codexReview(String id, {String? error}) =>
        CanopyPluginToggle(
          id: id,
          label: 'Codex review',
          detail: 'Codex only',
          selected: true,
          unavailableReason: reason,
          error: error,
        );
    await tester.pumpWidget(
      app(
        CanopyComposerPluginsSheet(
          state: CanopyPluginsSheetState.ready,
          onToggle: (_) {},
          onRetry: () {},
          sections: [
            (
              title: 'Plugins',
              rows: [
                codexReview('on', error: error),
                codexReview('same'),
                const CanopyPluginToggle(
                  id: 'other',
                  label: 'GitHub',
                  detail: 'Pull requests',
                  selected: false,
                ),
              ],
            ),
          ],
        ),
      ),
    );

    final row = find.byKey(const ValueKey('composer-plugin-on'));
    final tile = tester.widget<SwitchListTile>(row);
    // The error is the row's title: the label is gone, the reason stays.
    expect(
      find.descendant(
        of: find.byWidget(tile.title!),
        matching: find.text(error),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('Codex review')),
      findsNothing,
    );
    expect(
      find.descendant(of: row, matching: find.text(reason)),
      findsOneWidget,
    );
    expect(find.text(error), findsOneWidget);
    expect(find.text('Pull requests'), findsOneWidget);
    expect(
      find.descendant(
        of: row,
        matching: find.byWidgetPredicate(
          (widget) => widget is Tooltip && widget.message == error,
        ),
      ),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(row),
      isSemantics(
        label: '$error\n$reason',
        isLiveRegion: true,
        hasEnabledState: true,
        isEnabled: true,
        hasToggledState: true,
        isToggled: true,
        hasTapAction: true,
        hasFocusAction: true,
        isFocusable: true,
      ),
    );
    // The error adds no height to the row, even at 2x text.
    expect(
      tester.getSize(row).height,
      lessThanOrEqualTo(
        tester
            .getSize(find.byKey(const ValueKey('composer-plugin-same')))
            .height,
      ),
    );
    expect(tester.getSize(row).height, greaterThanOrEqualTo(48));
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });

  testWidgets('the title is not repeated by a leading Plugins section, and '
      'the search field filters rows by name', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    Future<void> pump({bool collections = false}) => tester.pumpWidget(
      app(
        CanopyComposerPluginsSheet(
          state: CanopyPluginsSheetState.ready,
          onToggle: (_) {},
          onRetry: () {},
          sections: [
            (
              title: 'Collections',
              rows: [
                if (collections)
                  const CanopyPluginToggle(
                    id: 'kit',
                    label: 'Release kit',
                    selected: false,
                  ),
              ],
            ),
            (
              title: 'Plugins',
              rows: const [
                CanopyPluginToggle(
                  id: 'github',
                  label: 'GitHub',
                  detail: 'Linear sync',
                  selected: true,
                ),
                CanopyPluginToggle(
                  id: 'linear',
                  label: 'Linear',
                  selected: false,
                ),
              ],
            ),
            (
              title: 'Skills',
              rows: const [
                CanopyPluginToggle(
                  id: 'notes',
                  label: 'Release notes',
                  selected: false,
                ),
              ],
            ),
          ],
        ),
      ),
    );

    await pump();
    // Only the sheet's own title says Plugins.
    expect(find.text('Plugins'), findsOneWidget);
    expect(find.text('Skills'), findsOneWidget);
    final search = find.byKey(const ValueKey('composer-plugins-search'));
    expect(
      find.descendant(of: search, matching: find.byType(CanopySearchField)),
      findsOneWidget,
    );
    // The search field sits between the title and the first row.
    expect(
      tester.getTopLeft(search).dy,
      greaterThan(tester.getTopLeft(find.text('Plugins')).dy),
    );
    expect(
      tester.getTopLeft(search).dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('composer-plugin-github')))
            .dy,
      ),
    );

    // Matches names case-insensitively, not descriptions; empty sections
    // drop their heading.
    await tester.enterText(find.byType(TextField), 'LIN');
    await tester.pump();
    expect(
      find.byKey(const ValueKey('composer-plugin-linear')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('composer-plugin-github')), findsNothing);
    expect(find.byKey(const ValueKey('composer-plugin-notes')), findsNothing);
    expect(find.text('Skills'), findsNothing);

    await tester.enterText(find.byType(TextField), 'zzz');
    await tester.pump();
    expect(find.text('No plugins match "zzz".'), findsOneWidget);

    await tester.tap(find.byTooltip('Clear'));
    await tester.pump();
    for (final id in ['github', 'linear', 'notes']) {
      expect(find.byKey(ValueKey('composer-plugin-$id')), findsOneWidget);
    }

    // Below another section, the Plugins heading still separates its rows.
    await pump(collections: true);
    expect(find.text('Collections'), findsOneWidget);
    expect(find.text('Plugins'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  for (final rowCount in [2, 30]) {
    testWidgets('the keyboard lifts the plugins sheet with $rowCount rows, '
        'keeping the search field and a row above it', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        app(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                showDragHandle: true,
                isScrollControlled: true,
                useSafeArea: true,
                builder: (_) => SafeArea(
                  child: CanopyComposerPluginsSheet(
                    state: CanopyPluginsSheetState.ready,
                    onToggle: (_) {},
                    onRetry: () {},
                    sections: [
                      (
                        title: 'Plugins',
                        rows: [
                          for (var i = 0; i < rowCount; i++)
                            CanopyPluginToggle(
                              id: 'p$i',
                              label: 'Plugin $i',
                              selected: false,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The keyboard opens over the bottom of the screen.
      const keyboard = 300.0;
      tester.view.viewInsets = const FakeViewPadding(bottom: keyboard);
      await tester.pumpAndSettle();

      final search = tester.getRect(
        find.byKey(const ValueKey('composer-plugins-search')),
      );
      final firstRow = tester.getRect(
        find.byKey(const ValueKey('composer-plugin-p0')),
      );
      expect(search.top, greaterThanOrEqualTo(24));
      expect(firstRow.bottom, lessThanOrEqualTo(844 - keyboard));
      // Every row can scroll into view above the keyboard.
      expect(
        tester
            .getRect(find.byKey(const ValueKey('composer-plugins-list')))
            .bottom,
        lessThanOrEqualTo(844 - keyboard),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
