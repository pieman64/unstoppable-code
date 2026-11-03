import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_presentation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';

const _account = 'production:7';
const _url = 'https://production.test/download';

final class _RecordingSharer implements LinkSharer {
  final calls = <({String text, String? subject, Rect? origin})>[];
  Object? error;

  @override
  Future<void> share({
    required String text,
    String? subject,
    Rect? origin,
  }) async {
    calls.add((text: text, subject: subject, origin: origin));
    if (error case final error?) throw error;
  }
}

class _Harness {
  _Harness({Set<String> dismissed = const {}})
    : store = InMemoryDesktopAppPromptStore(dismissed: dismissed) {
    controller = DesktopAppPromptController(
      store: store,
      isActive: () => active,
      downloadUrl: () => _url,
      sharer: sharer,
      copy: (text) async {
        if (copyError case final error?) throw error;
        copied.add(text);
      },
      showPrompt: (_) async {
        shows++;
        if (showError case final error?) throw error;
        return choice;
      },
    );
  }

  final InMemoryDesktopAppPromptStore store;
  final sharer = _RecordingSharer();
  final copied = <String>[];
  late final DesktopAppPromptController controller;
  bool active = true;
  int shows = 0;
  Object? showError;
  Object? copyError;
  DesktopAppPromptChoice choice = (
    action: DesktopAppPromptAction.notNow,
    shareOrigin: null,
  );

  /// Signed in as [account] with no desktop paired.
  _Harness eligible([String account = _account]) {
    controller.updateContext(
      accountScope: account,
      pairing: DesktopPairing.none,
    );
    return this;
  }
}

/// A context under a Scaffold, so a confirmation can show as a snack bar.
Future<BuildContext> _context(WidgetTester tester) async {
  late BuildContext captured;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) {
            captured = context;
            return const SizedBox();
          },
        ),
      ),
    ),
  );
  return captured;
}

/// Runs [body] with [debugPrint] silenced; restored before the test ends.
Future<void> _quietly(Future<void> Function() body) async {
  final original = debugPrint;
  debugPrint = (String? message, {int? wrapWidth}) {};
  try {
    await body();
  } finally {
    debugPrint = original;
  }
}

void main() {
  group('who is offered the desktop app', () {
    test('a signed-in account with no desktop', () {
      final h = _Harness().eligible();
      expect(h.controller.canOffer, isTrue);
    });

    test('not before the pairing probe answers', () {
      final h = _Harness();
      h.controller.updateContext(
        accountScope: _account,
        pairing: DesktopPairing.unknown,
      );
      expect(h.controller.canOffer, isFalse);
    });

    test('not with a paired desktop', () {
      final h = _Harness();
      h.controller.updateContext(
        accountScope: _account,
        pairing: DesktopPairing.paired,
      );
      expect(h.controller.canOffer, isFalse);
    });

    test('not while signed out', () {
      final h = _Harness();
      h.controller.updateContext(
        accountScope: null,
        pairing: DesktopPairing.none,
      );
      expect(h.controller.canOffer, isFalse);
    });

    test('not in demo mode or an unconfigured build', () {
      final h = _Harness().eligible()..active = false;
      expect(h.controller.canOffer, isFalse);
    });
  });

  group('a successful turn', () {
    test('raises the prompt for an eligible account', () async {
      final h = _Harness().eligible();
      expect(await h.controller.claimSuccessfulTurn(), isTrue);
      expect(h.controller.pendingPrompt, isTrue);
    });

    test('keeps claiming turns while the prompt is due', () async {
      final h = _Harness().eligible();
      await h.controller.claimSuccessfulTurn();
      expect(await h.controller.claimSuccessfulTurn(), isTrue);
    });

    for (final pairing in [DesktopPairing.unknown, DesktopPairing.paired]) {
      test('does nothing with pairing ${pairing.name}', () async {
        final h = _Harness();
        h.controller.updateContext(accountScope: _account, pairing: pairing);
        expect(await h.controller.claimSuccessfulTurn(), isFalse);
        expect(h.controller.pendingPrompt, isFalse);
      });
    }

    test('does nothing once the account closed the prompt, even after a '
        'relaunch or signing back in', () async {
      final h = _Harness(dismissed: {_account}).eligible();
      expect(await h.controller.claimSuccessfulTurn(), isFalse);
      expect(h.controller.pendingPrompt, isFalse);
    });

    test('a second account on the device is eligible on its own', () async {
      final h = _Harness(dismissed: {_account}).eligible('production:8');
      expect(await h.controller.claimSuccessfulTurn(), isTrue);
    });

    test('is dropped when the account changes during the lookup', () async {
      final h = _Harness().eligible();
      final claim = h.controller.claimSuccessfulTurn();
      h.controller.updateContext(
        accountScope: 'production:8',
        pairing: DesktopPairing.none,
      );
      expect(await claim, isFalse);
      expect(h.controller.pendingPrompt, isFalse);
    });

    test('pairing a desktop withdraws a due prompt', () async {
      final h = _Harness().eligible();
      await h.controller.claimSuccessfulTurn();
      h.controller.updateContext(
        accountScope: _account,
        pairing: DesktopPairing.paired,
      );
      expect(h.controller.pendingPrompt, isFalse);
    });
  });

  group('closing the prompt', () {
    for (final action in DesktopAppPromptAction.values) {
      testWidgets('with ${action.name} stops it opening on its own again', (
        tester,
      ) async {
        final context = await _context(tester);
        final h = _Harness().eligible()
          ..choice = (action: action, shareOrigin: null);
        await h.controller.claimSuccessfulTurn();

        await h.controller.presentPending(context);
        await tester.pump();

        expect(h.shows, 1);
        expect(await h.store.isDismissed(_account), isTrue);
        expect(h.controller.pendingPrompt, isFalse);
        expect(await h.controller.claimSuccessfulTurn(), isFalse);
      });
    }

    testWidgets('a failed save still keeps it closed this launch', (
      tester,
    ) async {
      final context = await _context(tester);
      final h = _Harness().eligible();
      h.store.failWritesWith = StateError('disk full');
      await h.controller.claimSuccessfulTurn();

      await _quietly(() => h.controller.presentPending(context));

      expect(await h.store.isDismissed(_account), isFalse);
      expect(await h.controller.claimSuccessfulTurn(), isFalse);
    });

    testWidgets('a sheet that fails to show counts as a dismissal', (
      tester,
    ) async {
      final context = await _context(tester);
      final h = _Harness().eligible()..showError = StateError('no navigator');
      await h.controller.claimSuccessfulTurn();

      await _quietly(() => h.controller.presentPending(context));

      expect(await h.store.isDismissed(_account), isTrue);
    });
  });

  group('actions', () {
    testWidgets('Share link shares the download page with a message', (
      tester,
    ) async {
      final context = await _context(tester);
      const origin = Rect.fromLTWH(16, 600, 358, 48);
      final h = _Harness().eligible()
        ..choice = (action: DesktopAppPromptAction.share, shareOrigin: origin);
      await h.controller.claimSuccessfulTurn();

      await h.controller.presentPending(context);

      expect(h.sharer.calls, hasLength(1));
      final call = h.sharer.calls.single;
      expect(
        call.text,
        'Get ${Brand.productDisplayName} for your computer: $_url',
      );
      expect(call.subject, '${Brand.productDisplayName} for your computer');
      expect(call.origin, origin);
    });

    testWidgets('a failed share is not an error the user sees', (tester) async {
      final context = await _context(tester);
      final h = _Harness().eligible()
        ..choice = (action: DesktopAppPromptAction.share, shareOrigin: null);
      h.sharer.error = StateError('unavailable');
      await h.controller.claimSuccessfulTurn();

      await _quietly(() => h.controller.presentPending(context));
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(await h.store.isDismissed(_account), isTrue);
    });

    testWidgets('Copy link copies the download page and confirms', (
      tester,
    ) async {
      final context = await _context(tester);
      final h = _Harness().eligible()
        ..choice = (action: DesktopAppPromptAction.copy, shareOrigin: null);
      await h.controller.claimSuccessfulTurn();

      await h.controller.presentPending(context);
      await tester.pump();

      expect(h.copied, [_url]);
      expect(find.text('Link copied'), findsOneWidget);
    });

    testWidgets('a failed copy says so', (tester) async {
      final context = await _context(tester);
      final h = _Harness().eligible()
        ..choice = (action: DesktopAppPromptAction.copy, shareOrigin: null)
        ..copyError = StateError('clipboard');
      await h.controller.claimSuccessfulTurn();

      await _quietly(() => h.controller.presentPending(context));
      await tester.pump();

      expect(find.text("Couldn't copy to clipboard"), findsOneWidget);
      expect(find.text('Link copied'), findsNothing);
    });
  });

  group('opening on request', () {
    testWidgets('works after the account closed the prompt', (tester) async {
      final context = await _context(tester);
      final h = _Harness(dismissed: {_account}).eligible();

      await h.controller.open(context);

      expect(h.shows, 1);
    });

    testWidgets('does nothing with a paired desktop', (tester) async {
      final context = await _context(tester);
      final h = _Harness();
      h.controller.updateContext(
        accountScope: _account,
        pairing: DesktopPairing.paired,
      );

      await h.controller.open(context);

      expect(h.shows, 0);
    });

    testWidgets('a due prompt is not shown twice', (tester) async {
      final context = await _context(tester);
      final h = _Harness().eligible();
      await h.controller.claimSuccessfulTurn();

      await h.controller.open(context);
      await h.controller.presentPending(context);

      expect(h.shows, 1);
    });
  });
}
