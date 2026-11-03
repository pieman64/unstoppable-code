import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/main.dart' as app;
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';

/// Captures deterministic promo/marketing screenshots of the app (e.g. for
/// store listings). Runs the real app in reviewer demo mode (every
/// repository resolves to its Mock* implementation — no network, no real
/// account data), signs in through the reviewer form, and screenshots three
/// home tabs. The web /download page no longer embeds these captures; the
/// harness remains for store-listing and marketing use.
///
/// The app renders ThemeMode.system, so the simulator appearance selects the
/// theme — run once per appearance for both variants:
///   xcrun simctl ui `DEVICE_ID` appearance dark   # or light
///   flutter drive --driver=test_driver/integration_test.dart \
///     --target=integration_test/promo_screenshots_test.dart -d `DEVICE_ID`
///
/// Raw captures land in build/promo_screenshots/ at 1206x2622 (@3x). The
/// top 186px is the safe-area inset reserved for the dynamic island (not
/// rendered in screenshots) — crop it for tighter promo crops.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('capture promo screenshots', (tester) async {
    await app.main();
    await tester.pumpAndSettle();

    // Same switch the store-reviewer gesture flips; set directly so the run
    // is deterministic. The auth provider rebuilds and reveals the
    // email/password form backed by MockAuthRepository.
    DemoMode.enabled.value = true;
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('reviewerEmailField')),
      'demo@example.com',
    );
    await tester.enterText(
      find.byKey(const Key('reviewerPasswordField')),
      'password',
    );
    await tester.tap(find.byKey(const Key('reviewerSignInButton')));
    await tester.pumpAndSettle(const Duration(seconds: 2));

    Future<void> switchTab(HomeTab tab) async {
      // A Settings destination shows a back button instead of the menu
      // button (CAN-3558).
      final back = find.byTooltip('Back');
      if (back.evaluate().isNotEmpty) {
        await tester.tap(back);
        await tester.pumpAndSettle();
      }
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      // Account has no menu row; the pinned Settings cog opens it, and the
      // Settings destinations open from Account.
      final fromAccount = settingsHomeTabs.contains(tab);
      await tester.tap(
        find.byKey(
          ValueKey(
            tab == HomeTab.account || fromAccount
                ? 'home-settings-button'
                : 'home-nav-${tab.name}',
          ),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 1));
      if (fromAccount) {
        await tester.tap(find.byKey(ValueKey('account-nav-${tab.name}')));
        await tester.pumpAndSettle(const Duration(seconds: 1));
      }
    }

    Future<void> capture(HomeTab tab, String name) async {
      await switchTab(tab);
      await binding.takeScreenshot(name);
    }

    // The Remote tab starts on the pairing screen —
    // MockRemoteControlRepository never auto-restores a connection — so a
    // well-formed demo code (any 6 digits other than the reserved
    // error-simulation code) is entered to reach the populated workspace
    // list before capturing it.
    await switchTab(HomeTab.remote);
    await tester.enterText(
      find.descendant(
        of: find.byType(ConnectDesktopView),
        matching: find.byType(TextField),
      ),
      '123456',
    );
    // Rebuild before tapping: the Connect button's onPressed is computed from
    // the field's completeness at the last build, so without this pump it is
    // still the disabled closure captured while the field was empty.
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle(const Duration(seconds: 2));
    await binding.takeScreenshot('workspaces');

    await capture(HomeTab.activity, 'activity');
    await capture(HomeTab.usage, 'overview');
  });
}
