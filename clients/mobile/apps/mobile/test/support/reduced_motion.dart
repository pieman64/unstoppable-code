import 'package:flutter_test/flutter_test.dart';

/// Forces reduce-motion accessibility for every test in the enclosing group.
///
/// [CometSpinner] holds its ring still and stops its animation controller
/// under reduce-motion, so tests that `pumpAndSettle` screens containing
/// always-on spinners (busy worktrees, running pipelines) still settle.
void useReducedMotion() {
  setUp(() {
    final binding = TestWidgetsFlutterBinding.ensureInitialized();
    binding.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
  });
  tearDown(() {
    TestWidgetsFlutterBinding.ensureInitialized().platformDispatcher
        .clearAccessibilityFeaturesTestValue();
  });
}
