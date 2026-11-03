import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_card.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/can_3715_activity_fixture.dart';
import '../../../../support/fake_remote_control_repository.dart';

/// CAN-3715 AC-08: in the home shell, a status bar tap on iOS scrolls
/// Activity to its top, as the platform's lists do. Scrolls that an animation
/// drives keep moving smoothly when a refresh lands midway.
void main() {
  setUp(() {
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  testWidgets('a status bar tap scrolls Activity to its top in the shell '
      '(AC-08)', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
    tester.view.devicePixelRatio = 3.0;
    tester.view.padding = const FakeViewPadding(top: 141);
    addTearDown(tester.view.reset);
    late AuthViewModel auth;
    await tester.runAsync(() async => auth = await can3715Auth());
    addTearDown(auth.dispose);
    await tester.pumpWidget(
      Can3715Shell(
        auth: auth,
        teamFeed: Can3715FeedRepository(personal: false),
        personalFeed: Can3715FeedRepository(personal: true),
        remote: FakeRemoteControlRepository(),
        cloudAvailable: true,
      ),
    );
    await tester.pumpAndSettle();
    final list = find
        .descendant(
          of: find.byType(FeedScreen),
          matching: find.byType(Scrollable),
        )
        .first;
    final position = tester.state<ScrollableState>(list).position;
    final firstRow = find.textContaining('feature/org-work-0');
    final listTop = tester.getTopLeft(firstRow).dy;

    // The reader goes deep. The last scroll end starts the offsets at their
    // row, so the top of the list is below 0.
    await tester.drag(list, const Offset(0, -1500));
    await tester.pumpAndSettle();
    await tester.drag(list, const Offset(0, -100));
    await tester.pumpAndSettle();
    expect(position.minScrollExtent, lessThan(0));

    tester.simulateStatusBarTap();
    await tester.pumpAndSettle();

    expect(position.pixels, position.minScrollExtent);
    expect(tester.getTopLeft(firstRow).dy, listTop);
    expect(tester.takeException(), isNull);
  }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

  for (final themed in const [false, true]) {
    for (final newer in const [0, 3]) {
      final change = themed ? 'and the theme change ' : '';
      testWidgets('a refresh that lands while a status bar tap $change'
          'scrolls Activity to its top keeps the motion smooth and reaches '
          'the newest row ($newer new) (AC-08)', (tester) async {
        tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
        tester.view.devicePixelRatio = 3.0;
        tester.view.padding = const FakeViewPadding(top: 141);
        addTearDown(tester.view.reset);
        final theme = ValueNotifier(ThemeMode.light);
        addTearDown(theme.dispose);
        late AuthViewModel auth;
        await tester.runAsync(() async => auth = await can3715Auth());
        addTearDown(auth.dispose);
        final feed = Can3715FeedRepository(personal: false);
        await tester.pumpWidget(_shell(auth, feed, theme));
        await tester.pumpAndSettle();
        final list = find
            .descendant(
              of: find.byType(FeedScreen),
              matching: find.byType(Scrollable),
            )
            .first;
        // The scroll view replaces its position when its dependencies, such
        // as the theme, change; read the current one.
        ScrollPosition position() =>
            tester.state<ScrollableState>(list).position;
        final viewModel = Provider.of<FeedViewModel>(
          tester.element(find.byType(FeedScreen)),
          listen: false,
        );
        final listTop = tester
            .getTopLeft(find.textContaining('feature/org-work-0'))
            .dy;
        await tester.drag(list, const Offset(0, -1500));
        await tester.pumpAndSettle();
        await tester.drag(list, const Offset(0, -100));
        await tester.pumpAndSettle();
        expect(position().minScrollExtent, lessThan(0));

        // A refresh is under way when the reader taps the status bar.
        final gate = feed.gate = Completer<void>();
        feed.newer = newer;
        await _resume(tester);
        tester.simulateStatusBarTap();
        final first = position();
        final activity = first.activity;
        expect(activity, isA<DrivenScrollActivity>());

        // The response lands midway, after a theme change replaced the
        // position. In every frame the rows move together toward the top,
        // never back and never faster than before it landed.
        var tops = _rowTops(tester);
        var fastest = 0.0;
        int? landed;
        for (var frame = 0; frame < 200; frame++) {
          if (themed && frame == 5) theme.value = ThemeMode.dark;
          if (frame == 20) {
            if (themed) {
              expect(position(), isNot(same(first)), reason: 'not replaced');
              expect(position().activity, same(activity));
            }
            gate.complete();
          }
          await tester.pump(const Duration(milliseconds: 16));
          if (landed == null && !viewModel.isLoading) {
            landed = frame;
            expect(position().activity, same(activity), reason: 'scroll ended');
          }
          final next = _rowTops(tester);
          final moves = [
            for (final MapEntry(:key, :value) in next.entries)
              if (tops[key] case final top?) value - top,
          ];
          final at = 'frame $frame';
          expect(moves, isNotEmpty, reason: '$at: no row stayed in view');
          expect(moves, everyElement(closeTo(moves.first, 1e-6)), reason: at);
          expect(moves.first, greaterThanOrEqualTo(0), reason: '$at: back');
          if (frame < 20) {
            fastest = math.max(fastest, moves.first);
          } else {
            expect(
              moves.first,
              lessThanOrEqualTo(fastest),
              reason: '$at: jump',
            );
          }
          tops = next;
          if (!tester.binding.hasScheduledFrame) break;
        }
        expect(landed, isNotNull, reason: 'the refresh committed');
        expect(tester.binding.hasScheduledFrame, isFalse);

        // The scroll ends at the top, with the newest row first.
        final newest = newer == 0
            ? 'feature/org-work-0'
            : 'feature/org-new-${newer - 1}';
        expect(position().pixels, position().minScrollExtent);
        expect(tester.getTopLeft(find.textContaining(newest)).dy, listTop);
        expect(tester.takeException(), isNull);
      }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));
    }
  }

  for (final (view, size, ratio) in const [
    ('phone', Size(1170, 2532), 3.0), // iPhone 13
    ('Android', Size(1080, 2400), 2.625), // the emulator's fractional ratio
  ]) {
    for (final themed in const [false, true]) {
      final change = themed ? 'and the theme change ' : '';
      for (final newer in const [0, 3]) {
        testWidgets('a keyboard Page Up that a refresh ${change}lands during '
            'moves the rows one page, smoothly ($newer new, $view) (AC-08)', (
          tester,
        ) async {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = ratio;
          addTearDown(tester.view.reset);
          final (:feed, :viewModel, :position, :theme) = await _deepReader(
            tester,
          );

          // A refresh is under way when the reader presses Page Up. The
          // keyboard shortcut runs the app's scroll action for the focused
          // row.
          final gate = feed.gate = Completer<void>();
          feed.newer = newer;
          await _resume(tester);
          expect(viewModel.isLoading, isTrue);
          Actions.invoke(
            tester.element(find.byType(FeedCard).hitTestable().first),
            const ScrollIntent(
              direction: AxisDirection.up,
              type: ScrollIncrementType.page,
            ),
          );
          expect(position().activity, isA<DrivenScrollActivity>());

          // Flutter's scroll action moves one page in 100 ms, eased in and
          // out.
          await _expectEasedTravel(
            tester,
            gate: gate,
            viewModel: viewModel,
            position: position,
            theme: themed ? theme : null,
            distance: 0.8 * position().viewportDimension,
            duration: const Duration(milliseconds: 100),
            curve: Curves.easeInOut,
            inserted: newer,
          );
          expect(tester.takeException(), isNull);
        });
      }
    }

    for (final (themed, frames) in [
      (false, const <Duration>[]),
      (true, const <Duration>[]),
      if (view == 'Android') (true, _recordedFrames),
    ]) {
      final change = themed ? 'and the theme change ' : '';
      final recorded = frames.isEmpty ? '' : ', recorded frames';
      testWidgets('an animated reveal of a row that a refresh ${change}lands '
          'during ends with the row at the top ($view$recorded) (AC-08)', (
        tester,
      ) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = ratio;
        addTearDown(tester.view.reset);
        final (:feed, :viewModel, :position, :theme) = await _deepReader(
          tester,
        );
        final list = tester.getRect(
          find
              .descendant(
                of: find.byType(FeedScreen),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        // The highest row in the lower half of the list.
        final id = _rowTops(tester).entries
            .where(
              (row) => row.value > list.center.dy && row.value < list.bottom,
            )
            .reduce((a, b) => a.value < b.value ? a : b)
            .key;
        final card = find.byWidgetPredicate(
          (w) => w is FeedCard && w.item.id == id,
        );
        final distance = list.top - tester.getTopLeft(card).dy;

        final gate = feed.gate = Completer<void>();
        feed.newer = 3;
        await _resume(tester);
        expect(viewModel.isLoading, isTrue);
        if (frames.isNotEmpty) {
          // The recording read the theme of the screen in each frame, so the
          // screen rebuilt in each frame of the theme change, and each
          // rebuild started the offsets at the reader's row.
          Theme.of(tester.element(find.byType(FeedScreen)));
        }
        unawaited(
          Scrollable.ensureVisible(
            tester.element(card),
            duration: const Duration(milliseconds: 300),
          ),
        );
        expect(position().activity, isA<DrivenScrollActivity>());

        await _expectEasedTravel(
          tester,
          gate: gate,
          viewModel: viewModel,
          position: position,
          theme: themed ? theme : null,
          distance: distance,
          duration: const Duration(milliseconds: 300),
          curve: Curves.ease,
          inserted: 3,
          frames: frames,
        );
        expect(tester.getTopLeft(card).dy, closeTo(list.top, 1e-3));
        expect(tester.takeException(), isNull);
      });
    }
  }
}

/// The frame intervals of a profile recording on the Android emulator, from
/// the first frame of an animated reveal until a refresh landed after the
/// theme change: 50 ms apart, then 33 ms. The last move of the offsets'
/// start before the response is in an earlier frame than the response.
const _recordedFrames = [
  Duration(milliseconds: 16),
  Duration(milliseconds: 50),
  Duration(milliseconds: 50),
  Duration(milliseconds: 50),
  Duration(milliseconds: 50),
  Duration(microseconds: 33333),
];

/// The shell on Activity, in the theme mode of [theme].
Widget _shell(
  AuthViewModel auth,
  Can3715FeedRepository feed,
  ValueListenable<ThemeMode> theme,
) => ValueListenableBuilder(
  valueListenable: theme,
  builder: (context, mode, _) => Can3715Shell(
    auth: auth,
    teamFeed: feed,
    personalFeed: Can3715FeedRepository(personal: true),
    remote: FakeRemoteControlRepository(),
    cloudAvailable: true,
    themeMode: mode,
  ),
);

/// Pumps the shell on Activity in the light theme and makes the reader go
/// deep. The last scroll end starts the offsets at their row, so the top of
/// the list is below 0. [position] reads the list's current position: the
/// scroll view replaces it when its dependencies, such as the theme, change.
Future<
  ({
    Can3715FeedRepository feed,
    FeedViewModel viewModel,
    ScrollPosition Function() position,
    ValueNotifier<ThemeMode> theme,
  })
>
_deepReader(WidgetTester tester) async {
  late AuthViewModel auth;
  await tester.runAsync(() async => auth = await can3715Auth());
  addTearDown(auth.dispose);
  final feed = Can3715FeedRepository(personal: false);
  final theme = ValueNotifier(ThemeMode.light);
  addTearDown(theme.dispose);
  await tester.pumpWidget(_shell(auth, feed, theme));
  await tester.pumpAndSettle();
  final list = find
      .descendant(
        of: find.byType(FeedScreen),
        matching: find.byType(Scrollable),
      )
      .first;
  ScrollPosition position() => tester.state<ScrollableState>(list).position;
  await tester.drag(list, const Offset(0, -1500));
  await tester.pumpAndSettle();
  await tester.drag(list, const Offset(0, -100));
  await tester.pumpAndSettle();
  expect(position().minScrollExtent, lessThan(0));
  final viewModel = Provider.of<FeedViewModel>(
    tester.element(find.byType(FeedScreen)),
    listen: false,
  );
  return (feed: feed, viewModel: viewModel, position: position, theme: theme);
}

/// Returns the app to the foreground, which refreshes Activity.
Future<void> _resume(WidgetTester tester) async {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await tester.pump();
}

/// Pumps the frames of a scroll that an animation drives, which moves the
/// rows [distance] down the screen in [duration] along [curve]. The refresh
/// response behind [gate] lands midway and moves the offsets under the rows.
/// In every frame the rows in view move together by the step of the
/// animation in that frame, so the response neither interrupts nor extends
/// the motion. With a [theme], the theme turns dark as the motion starts, and
/// the response lands after that change replaced the list's position. The
/// response adds [inserted] rows above the rows in view, and the content
/// above them changes in no other frame.
///
/// [frames] are the intervals of the first frames of a recording; later
/// frames are 16 ms apart. As in that recording, the response then lands
/// only after the theme change stops replacing the position.
Future<void> _expectEasedTravel(
  WidgetTester tester, {
  required Completer<void> gate,
  required FeedViewModel viewModel,
  required ScrollPosition Function() position,
  ValueNotifier<ThemeMode>? theme,
  required double distance,
  required Duration duration,
  required Curve curve,
  required int inserted,
  List<Duration> frames = const [],
}) async {
  final list = tester.getRect(
    find
        .descendant(
          of: find.byType(FeedScreen),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  var tops = _rowTops(tester, within: list);
  // The rows are alike, so each one takes the same space in the list.
  final sorted = tops.values.toList()..sort();
  final pitch = sorted[1] - sorted[0];
  for (var i = 2; i < sorted.length; i++) {
    expect(sorted[i] - sorted[i - 1], closeTo(pitch, 1e-6), reason: 'pitch');
  }
  var pixels = position().pixels;
  var minimum = position().minScrollExtent;
  final first = position();
  final activity = first.activity;
  final known = {for (final item in viewModel.items) item.id};
  var current = first;
  theme?.value = ThemeMode.dark;
  Duration? start;
  var eased = 0.0;
  var travel = 0.0;
  int? landed;
  var restarted = false;
  for (var frame = 0; frame < 120; frame++) {
    // The time stamp of the frame, the one the animation ticks with.
    Duration? stamp;
    tester.binding.scheduleFrameCallback((time) => stamp = time);
    await tester.pump(
      frame < frames.length ? frames[frame] : const Duration(milliseconds: 16),
    );
    final replaced = !identical(position(), current);
    current = position();
    start ??= stamp;
    final t = math.min(
      1.0,
      (stamp! - start!).inMicroseconds / duration.inMicroseconds,
    );
    final next = _rowTops(tester, within: list);
    final moves = [
      for (final MapEntry(:key, :value) in next.entries)
        if (tops[key] case final top?) value - top,
    ];
    final at = 'frame $frame';
    expect(moves, isNotEmpty, reason: '$at: no row stayed in view');
    expect(moves, everyElement(closeTo(moves.first, 1e-6)), reason: at);
    final step = distance * (curve.transform(t) - eased);
    expect(moves.first, closeTo(step, 1e-3), reason: '$at: not the step');
    eased = curve.transform(t);
    travel += moves.first;
    // The offsets can restart at another row under the rows in view; the
    // top of the content moves with them. A row's distance from that top
    // changes only with the content above it.
    final origin = position().pixels - pixels + moves.first;
    final grown = origin - (position().minScrollExtent - minimum);
    if (t < 1 &&
        origin.abs() > 1 &&
        identical(position().activity, activity) &&
        (theme == null || !identical(position(), first))) {
      restarted = true;
    }
    if (landed == null && !viewModel.isLoading) {
      landed = frame;
      // More animation frames follow the response.
      expect(t, lessThan(1), reason: '$at: landed after the scroll');
      expect(position().activity, same(activity), reason: at);
      expect(activity!.delegate, same(position()), reason: '$at: delegate');
      expect(
        viewModel.items.takeWhile((item) => !known.contains(item.id)),
        hasLength(inserted),
        reason: '$at: the new rows above',
      );
      expect(
        grown,
        closeTo(inserted * pitch, 1e-3),
        reason: '$at: the extent of the new rows',
      );
    } else {
      expect(grown, closeTo(0, 1e-3), reason: '$at: the content above moved');
    }
    // The response lands about midway.
    if (!gate.isCompleted && t >= 0.4 && !(frames.isNotEmpty && replaced)) {
      if (theme != null) {
        // The theme change replaced the position, which took the motion over.
        expect(position(), isNot(same(first)), reason: '$at: not replaced');
        expect(position().activity, same(activity), reason: at);
      }
      gate.complete();
    }
    tops = next;
    pixels = position().pixels;
    minimum = position().minScrollExtent;
    if (t == 1 && landed != null && !tester.binding.hasScheduledFrame) break;
  }
  expect(landed, isNotNull, reason: 'the refresh committed');
  expect(restarted, isTrue, reason: 'the offsets restarted during the motion');
  expect(tester.binding.hasScheduledFrame, isFalse);
  expect(travel, closeTo(distance, 1e-3));
  expect(position().outOfRange, isFalse);
}

/// The screen top of each feed row laid out in Activity, by row ID. With
/// [within], only the rows in that part of the screen: a sliver past an end
/// of the viewport places its rows as if at that end, but does not paint
/// them.
Map<String, double> _rowTops(WidgetTester tester, {Rect? within}) => {
  for (final element in find.byType(FeedCard, skipOffstage: false).evaluate())
    if ((element.widget, element.renderObject) case (
      FeedCard(:final item),
      RenderBox box,
    ))
      if (box.localToGlobal(Offset.zero) & box.size case final rect
          when within == null || rect.overlaps(within))
        item.id: rect.top,
};
