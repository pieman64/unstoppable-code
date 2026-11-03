// Pins the CAN-3715 notification-tap boundary (`apps/mobile/AGENTS.md`:
// features do not import each other). The binding receives the live context,
// context selection and Personal Activity availability as callbacks from the
// shell composition; it never reads the auth feature itself. Only the home
// shell tab types that the binding already navigated with stay allowed.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'package:flutter_test/flutter_test.dart';

import 'account_usage_boundary_test.dart' show foreignFeatureImports;

const pushTapBinding = 'lib/ui/features/remote/views/push_tap_binding.dart';

/// Foreign-feature imports of [pushTapBinding] that predate CAN-3715.
const allowedForeignImports = {
  'package:mobile/ui/features/home/home_tab.dart',
  'package:mobile/ui/features/home/home_tab_controller.dart',
};

void main() {
  test('the notification-tap binding imports no other feature beyond the '
      'home tabs', () {
    final violations = [
      for (final found in foreignFeatureImports(
        pushTapBinding,
        ownFeature: 'remote',
      ))
        if (!allowedForeignImports.contains(found.split(': ').last)) found,
    ];
    expect(violations, isEmpty);
  });
}
