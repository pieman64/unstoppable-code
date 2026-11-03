// CAN-3622 — device regression flow for the shared search field and the
// Pipeline Runs Run action. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3622_search_field_device_test.dart \
//     -d <device-id>
//
// In both themes it opens Activity, checks that the Run glyph and label share
// the accent, searches the pipeline picker and clears the search, and checks
// that the feed filter sheet's field Clear only empties the draft while the
// keyboard search action still applies it. Data is synthetic
// (`test/support/search_field_fixture.dart`): no desktop, account or network.
// Screenshots live in the separate capture harness.

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/search_field_fixture.dart';

const _run = ValueKey('pipeline-dispatch-open');
const _search = ValueKey('pipeline-picker-search');

Finder _glyphIn(Finder parent, CanopyGlyph glyph) => find.descendant(
  of: parent,
  matching: find.byWidgetPredicate(
    (widget) => widget is CanopyIcon && widget.glyph == glyph,
  ),
);

Color? _paintedColor(WidgetTester tester, Finder text) => tester
    .renderObject<RenderParagraph>(
      find.descendant(
        of: text,
        matching: find.byType(RichText),
        matchRoot: true,
      ),
    )
    .text
    .style
    ?.color;

String _text(WidgetTester tester, Finder field) => tester
    .widget<EditableText>(
      find.descendant(of: field, matching: find.byType(EditableText)),
    )
    .controller
    .text;

void _expectAtLeast(Size size, double side) {
  expect(size.width, greaterThanOrEqualTo(side));
  expect(size.height, greaterThanOrEqualTo(side));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<RemoteControlViewModel> openActivity(
    WidgetTester tester,
    ThemeMode mode, {
    bool supportsDispatch = true,
  }) async {
    final viewModel = RemoteControlViewModel(
      repository: searchFieldRemoteRepository(
        supportsDispatch: supportsDispatch,
      ),
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(searchFieldRemoteHost(viewModel, themeMode: mode));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Pipeline Runs'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
    return viewModel;
  }

  Future<void> unmount(
    WidgetTester tester, [
    RemoteControlViewModel? viewModel,
  ]) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    viewModel?.dispose();
  }

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('Run shares the accent and the picker search clears '
        '($label)', (tester) async {
      final viewModel = await openActivity(tester, mode);

      final run = find.byKey(_run);
      final colors = AppColors.of(tester.element(run));
      expect(
        tester.widget<CanopyIcon>(_glyphIn(run, CanopyGlyph.play)).tint,
        colors.accent,
      );
      expect(
        _paintedColor(
          tester,
          find.descendant(of: run, matching: find.text('Run')),
        ),
        colors.accent,
      );
      _expectAtLeast(tester.getSize(run), 44);

      await tester.tap(run);
      await tester.pumpAndSettle();
      final field = find.byKey(_search);
      final magnifier = _glyphIn(field, CanopyGlyph.magnifyingGlass);
      expect(
        tester.widget<CanopyIcon>(magnifier).tint,
        colors.foregroundSecondary,
      );
      expect(tester.getSize(magnifier), const Size.square(20));

      final clear = find.descendant(
        of: field,
        matching: find.byTooltip('Clear'),
      );
      expect(clear, findsNothing);
      await tester.tap(field);
      await tester.enterText(field, 'staging');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('pipeline-picker-row:deploy')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('pipeline-picker-row:smoke')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('pipeline-picker-row:review')),
        findsNothing,
      );
      expect(clear, findsOneWidget);
      _expectAtLeast(tester.getSize(clear), 48);

      await tester.tap(clear);
      await tester.pumpAndSettle();
      expect(_text(tester, field), isEmpty);
      expect(
        find.byKey(const ValueKey('pipeline-picker-row:review')),
        findsOneWidget,
      );
      expect(clear, findsNothing);

      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.byKey(_run), findsOneWidget);
      expect(tester.takeException(), isNull);
      await unmount(tester, viewModel);
    });

    testWidgets('a desktop without dispatch shows no Run ($label)', (
      tester,
    ) async {
      final viewModel = await openActivity(
        tester,
        mode,
        supportsDispatch: false,
      );
      expect(find.text('Pipeline Runs'), findsOneWidget);
      expect(find.byKey(_run), findsNothing);
      await unmount(tester, viewModel);
    });

    testWidgets('feed field Clear waits for Apply; search applies ($label)', (
      tester,
    ) async {
      final repository = RecordingFeedRepository();
      await tester.pumpWidget(searchFieldFeedHost(repository, themeMode: mode));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();

      final field = find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(TextField),
      );
      await tester.tap(field);
      await tester.enterText(field, 'deploy');
      await tester.pumpAndSettle();
      final clear = find.descendant(
        of: field,
        matching: find.byTooltip('Clear'),
      );
      expect(clear, findsOneWidget);
      final fetches = repository.queries.length;

      await tester.tap(clear);
      await tester.pumpAndSettle();
      expect(_text(tester, field), isEmpty);
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(repository.queries, hasLength(fetches));

      await tester.enterText(field, 'deploy');
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(repository.queries.last, 'deploy');
      expect(tester.takeException(), isNull);
      await unmount(tester);
    });
  }
}
