// Pins the CAN-3715 Activity composition boundary (`apps/mobile/AGENTS.md`:
// features do not import each other). The shell's Activity refresh binding
// and Remote Control notice receive the feed reload, the connection state and
// the Connect action from the composition; they read no other feature's model.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'package:flutter_test/flutter_test.dart';

import 'account_usage_boundary_test.dart' show foreignFeatureImports;

const activityCompositionFiles = [
  'lib/ui/features/home/views/activity_refresh_binding.dart',
  'lib/ui/features/home/views/widgets/connect_remote_control_notice.dart',
];

const homeShell = 'lib/ui/features/home/views/home_shell.dart';

void main() {
  for (final path in activityCompositionFiles) {
    test('$path imports no other feature', () {
      expect(foreignFeatureImports(path, ownFeature: 'home'), isEmpty);
    });
  }

  test('$homeShell imports no auth feature', () {
    final auth = [
      for (final found in foreignFeatureImports(homeShell, ownFeature: 'home'))
        if (found.contains('/features/auth/')) found,
    ];
    expect(auth, isEmpty);
  });
}
