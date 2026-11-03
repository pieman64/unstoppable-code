// CAN-3644 device verification: the Files tab of a worktree chat's
// Activity & files drawer shows loading, not "No changed files.", until the
// changed files the drawer asked the desktop to project have been read back;
// it keeps a cached list and its scroll position while refreshing, even when
// the relay's cache changes before the projection lands, offers Retry after
// a failure but not while offline, ignores another worktree's projection, and loads again
// within its deadline when the session is replaced while the drawer stays
// open. A load that joins a request whose projection already landed settles
// on the next read; a reopening that sends a new request waits for that
// request's own projection. Run from
// apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3644_changed_files_test.dart \
//     --dart-define=CAN3644_THEME=dark -d <device-id>
//
// Add --dart-define=CAN3644_REDUCED_MOTION=true to run with animations
// disabled. The production chat screen, view model and theme run on
// synthetic fixtures (test/support/changed_files_fixture.dart): no desktop,
// account or network. The fixture holds the desktop's projection until a
// scenario lands it, and can hold the reads that follow it.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/changed_files_fixture.dart';

const _theme = String.fromEnvironment('CAN3644_THEME', defaultValue: 'light');
const _reducedMotion = bool.fromEnvironment('CAN3644_REDUCED_MOTION');

const _loading = 'Loading changed files…';
const _refreshing = 'Checking for changes…';
const _empty = 'No changed files.';
const _failed = "Couldn't load changed files. Try again.";
const _timedOut = 'Changed files took too long to load. Try again.';
const _offline =
    'Not connected to your desktop. Go back and reconnect to load changed '
    'files.';

/// Load deadline for the reconnect scenarios, short enough to watch expire.
const _shortTimeout = Duration(seconds: 3);

/// Load deadline that leaves time to scroll the cached list before it ends.
const _scrollTimeout = Duration(seconds: 5);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  if (!const {'light', 'dark'}.contains(_theme)) {
    throw ArgumentError.value(_theme, 'CAN3644_THEME');
  }

  // Real-time frames without pumpAndSettle: the loading spinner animates.
  Future<void> hold(WidgetTester tester, [int milliseconds = 800]) async {
    final end = DateTime.now().add(Duration(milliseconds: milliseconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  Future<(ChangedFilesFixtureRepository, RemoteControlViewModel)> start(
    WidgetTester tester, {
    Object? projectionError,
    Duration hydrationTimeout = kRemoteHydrationTimeout,
  }) async {
    final repository = ChangedFilesFixtureRepository()
      ..projectionError = projectionError;
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      hydrationTimeout: hydrationTimeout,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(host(viewModel));
    await hold(tester, 1000);
    return (repository, viewModel);
  }

  Future<void> openFiles(WidgetTester tester, {bool swipe = false}) async {
    if (swipe) {
      final size = tester.getSize(find.byType(Scaffold).first);
      await tester.dragFrom(
        Offset(size.width - 2, size.height / 2),
        Offset(-size.width * 0.8, 0),
      );
    } else {
      await tester.tap(find.byKey(const ValueKey('open-activity')));
    }
    await hold(tester);
    await tester.tap(find.text('Files'));
    await hold(tester);
  }

  Future<void> closeDrawer(WidgetTester tester) async {
    Navigator.of(tester.element(find.byType(Drawer))).pop();
    await hold(tester);
  }

  Future<void> finish(
    WidgetTester tester,
    RemoteControlViewModel viewModel,
  ) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await hold(tester, 200);
    viewModel.dispose();
  }

  for (final swipe in [false, true]) {
    final entry = swipe ? 'edge swipe' : 'toolbar';
    for (final empty in [false, true]) {
      testWidgets('Files via $entry loads until the projected '
          '${empty ? 'empty' : 'populated'} result is read', (tester) async {
        final (repository, viewModel) = await start(tester);
        await openFiles(tester, swipe: swipe);
        expect(find.text(_loading), findsOneWidget);
        expect(find.text(_empty), findsNothing);

        // The projection lands; the read that follows it is held.
        final read = Completer<void>();
        repository.worktreeStateSlicesGate = read;
        repository.landProjection(
          'wt-1',
          empty ? const [] : changedFilesFirstProjection,
        );
        await hold(tester);
        expect(find.text(_loading), findsOneWidget);
        expect(find.text(_empty), findsNothing);

        read.complete();
        repository.worktreeStateSlicesGate = null;
        await hold(tester);
        expect(find.text(_loading), findsNothing);
        expect(find.text(_empty), empty ? findsOneWidget : findsNothing);
        expect(
          find.text('invoice_total.dart'),
          empty ? findsNothing : findsOneWidget,
        );
        await finish(tester, viewModel);
      });
    }
  }

  testWidgets('a reopened drawer keeps cached files until the refreshed '
      'result replaces them', (tester) async {
    final (repository, viewModel) = await start(tester);
    await openFiles(tester);
    repository.landProjection('wt-1', changedFilesFirstProjection);
    await hold(tester);
    expect(find.text('tax_rules.dart'), findsOneWidget);

    await closeDrawer(tester);
    await openFiles(tester, swipe: true);
    expect(find.text('tax_rules.dart'), findsOneWidget);
    expect(find.text(_refreshing), findsOneWidget);

    repository.landProjection('wt-1', const []);
    await hold(tester);
    expect(find.text('tax_rules.dart'), findsNothing);
    expect(find.text(_refreshing), findsNothing);
    expect(find.text(_empty), findsOneWidget);
    await finish(tester, viewModel);
  });

  // A push tap asks for the worktree without a Files load. Its projection
  // lands while the read that follows it is still held, so the request is
  // pending when Files opens. The load joins it, and the next read settles
  // it without the deadline.
  testWidgets('Files opened after a pending request\'s projection landed '
      'loads until the next read, without the deadline', (tester) async {
    final (repository, viewModel) = await start(tester);
    viewModel.ensureWorktreeState(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      refresh: true,
    );
    await hold(tester);
    final reads = Completer<void>();
    repository.worktreeStateSlicesGate = reads;
    repository.landProjection('wt-1', changedFilesFirstProjection);
    await hold(tester);

    await openFiles(tester);
    expect(repository.requestWorktreeStateCalls, 1);
    expect(find.text(_loading), findsOneWidget);
    expect(find.text(_empty), findsNothing);

    repository.worktreeStateSlicesGate = null;
    reads.complete();
    await hold(tester);
    expect(find.text('invoice_total.dart'), findsOneWidget);
    expect(find.text(_loading), findsNothing);
    expect(find.text(_refreshing), findsNothing);
    expect(find.text(_timedOut), findsNothing);
    await finish(tester, viewModel);
  });

  // A refreshing read after a landing lets the request finish while Files
  // still loads. Reopening the drawer sends a new request, and an eager
  // read before its projection keeps the cached list and the refresh.
  testWidgets('a reopening after a refreshing read keeps cached files until '
      'its own projection is read', (tester) async {
    final (repository, viewModel) = await start(tester);
    await openFiles(tester);
    repository.landProjection('wt-1', changedFilesFirstProjection);
    await hold(tester);
    expect(find.text('tax_rules.dart'), findsOneWidget);

    await closeDrawer(tester);
    await openFiles(tester);
    repository.worktreeStateSlicesRefreshing = true;
    repository.landProjection('wt-1', changedFilesSecondProjection);
    await hold(tester);
    expect(find.text('tax_rules.dart'), findsOneWidget);
    expect(find.text(_refreshing), findsOneWidget);

    repository
      ..worktreeStateSlicesRefreshing = false
      ..cacheFiles('wt-1', const []);
    await closeDrawer(tester);
    await openFiles(tester, swipe: true);
    expect(repository.requestWorktreeStateCalls, 3);
    expect(find.text(_empty), findsNothing);
    expect(find.text('tax_rules.dart'), findsOneWidget);
    expect(find.text(_refreshing), findsOneWidget);

    repository.landProjection('wt-1', changedFilesSecondProjection);
    await hold(tester);
    expect(find.text('currency_format.dart'), findsOneWidget);
    expect(find.text('tax_rules.dart'), findsNothing);
    expect(find.text(_refreshing), findsNothing);
    await finish(tester, viewModel);
  });

  // The relay's cache changes before the reopened drawer's projection
  // lands. Its eager answer confirms nothing: the shown list and its scroll
  // position stay through the refresh, the deadline and Retry, until the
  // read after the projection replaces them.
  for (final eager in ['empty', 'different']) {
    testWidgets('an eager $eager roster keeps the cached files and scroll '
        'position until the projected roster is read', (tester) async {
      final (repository, viewModel) = await start(
        tester,
        hydrationTimeout: _scrollTimeout,
      );
      await openFiles(tester);
      repository.landProjection('wt-1', changedFilesLongProjection);
      await hold(tester);
      expect(find.text('rule_00.dart'), findsOneWidget);

      final roster = eager == 'empty'
          ? const <Map<String, dynamic>>[]
          : changedFilesSecondProjection;
      repository.cacheFiles('wt-1', roster);
      await closeDrawer(tester);
      await openFiles(tester, swipe: true);
      expect(find.text(_refreshing), findsOneWidget);
      expect(find.text('rule_00.dart'), findsOneWidget);

      final list = find.byKey(const ValueKey('changed-files-list'));
      ScrollPosition position() => tester
          .state<ScrollableState>(
            find.descendant(of: list, matching: find.byType(Scrollable)),
          )
          .position;
      await tester.drag(list, const Offset(0, -300));
      await hold(tester, 300);
      final offset = position().pixels;
      expect(offset, greaterThan(0));

      void expectCachedList() {
        expect(find.text(_empty), findsNothing);
        expect(find.text(_loading), findsNothing);
        expect(find.text('currency_format.dart'), findsNothing);
        expect(find.textContaining('rule_'), findsWidgets);
        expect(position().pixels, offset);
      }

      expect(find.text(_refreshing), findsOneWidget);
      expectCachedList();
      await hold(tester, _scrollTimeout.inMilliseconds);
      expect(find.text(_timedOut), findsOneWidget);
      expectCachedList();

      await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
      await hold(tester);
      expect(find.text(_refreshing), findsOneWidget);
      expectCachedList();

      repository.landProjection('wt-1', roster);
      await hold(tester);
      expect(find.text(_refreshing), findsNothing);
      expect(find.textContaining('rule_'), findsNothing);
      expect(
        find.text(eager == 'empty' ? _empty : 'currency_format.dart'),
        findsOneWidget,
      );
      await finish(tester, viewModel);
    });
  }

  testWidgets('a failed projection offers Retry, which reloads', (
    tester,
  ) async {
    final (repository, viewModel) = await start(
      tester,
      projectionError: changedFilesProjectionError,
    );
    await openFiles(tester);
    expect(find.text(_failed), findsOneWidget);
    expect(find.text(_empty), findsNothing);
    expect(find.text(_loading), findsNothing);

    await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
    await hold(tester);
    expect(find.text(_loading), findsOneWidget);
    repository.landProjection('wt-1', changedFilesSecondProjection);
    await hold(tester);
    expect(find.text('currency_format.dart'), findsOneWidget);
    expect(find.text(_failed), findsNothing);
    await finish(tester, viewModel);
  });

  testWidgets('another worktree\'s projection does not settle the open one', (
    tester,
  ) async {
    final (repository, viewModel) = await start(tester);
    await openFiles(tester);
    await tester.pumpWidget(host(viewModel, worktreeLocalId: 'wt-2'));
    await hold(tester);
    await openFiles(tester);

    repository.landProjection('wt-1', changedFilesFirstProjection);
    await hold(tester);
    expect(find.text('invoice_total.dart'), findsNothing);
    expect(find.text(_loading), findsOneWidget);

    repository.landProjection('wt-2', changedFilesOtherWorktree);
    await hold(tester);
    expect(find.text('release_notes.md'), findsOneWidget);
    await finish(tester, viewModel);
  });

  // The pairing is replaced while Files stays open. The relay's cache no
  // longer holds the old projection, so the new session's load starts with
  // no list; it must end within its deadline, not spin.
  for (final outcome in ['settles', 'fails', 'times out']) {
    testWidgets('Files left open across a reconnect loads again and '
        '$outcome', (tester) async {
      final (repository, viewModel) = await start(
        tester,
        hydrationTimeout: _shortTimeout,
      );
      await openFiles(tester);
      repository.landProjection('wt-1', changedFilesFirstProjection);
      await hold(tester);
      expect(find.text('tax_rules.dart'), findsOneWidget);

      await viewModel.disconnect();
      await hold(tester);
      expect(find.text(_offline), findsOneWidget);
      expect(find.text(_empty), findsNothing);
      // Nothing can be requested offline: no Retry that would do nothing.
      expect(find.byKey(const ValueKey('retry-changed-files')), findsNothing);

      repository.worktreeStateSlices.remove('wt-1');
      if (outcome == 'fails') {
        repository.projectionError = changedFilesProjectionError;
      }
      final requests = repository.requestWorktreeStateCalls;
      await viewModel.connect('123456');
      await hold(tester);
      expect(find.byType(Drawer), findsOneWidget);
      expect(repository.requestWorktreeStateCalls, requests + 1);

      switch (outcome) {
        case 'settles':
          expect(find.text(_loading), findsOneWidget);
          repository.landProjection('wt-2', changedFilesOtherWorktree);
          await hold(tester);
          expect(find.text(_loading), findsOneWidget);
          repository.landProjection('wt-1', changedFilesSecondProjection);
          await hold(tester);
          expect(find.text('currency_format.dart'), findsOneWidget);
          expect(find.text(_loading), findsNothing);
        case 'fails':
          expect(find.text(_failed), findsOneWidget);
        case 'times out':
          expect(find.text(_loading), findsOneWidget);
          await hold(tester, _shortTimeout.inMilliseconds + 500);
          expect(find.text(_timedOut), findsOneWidget);
          expect(find.text(_loading), findsNothing);
      }
      expect(find.text(_empty), findsNothing);

      if (outcome != 'settles') {
        await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
        await hold(tester);
        expect(find.text(_loading), findsOneWidget);
        repository.landProjection('wt-1', changedFilesSecondProjection);
        await hold(tester);
        expect(find.text('currency_format.dart'), findsOneWidget);
      }
      await finish(tester, viewModel);
    });
  }
}

Widget host(
  RemoteControlViewModel viewModel, {
  String worktreeLocalId = 'wt-1',
}) => changedFilesHost(
  viewModel,
  worktreeLocalId: worktreeLocalId,
  themeMode: _theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
  reduceMotion: _reducedMotion,
);
