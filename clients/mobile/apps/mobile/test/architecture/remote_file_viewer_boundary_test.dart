// Pins the CAN-5130 worktree file viewer boundaries (`apps/mobile/AGENTS.md`):
// the image source policy is pure Dart, so containment rules are tested
// without Flutter, and the viewer imports no other feature.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'package:flutter_test/flutter_test.dart';

import 'account_usage_boundary_test.dart' show foreignFeatureImports;
import 'remote_engine_boundary_test.dart' show importClosure, isAllowed;

const pathPolicy =
    'lib/ui/features/remote/view_models/remote_file_image_path.dart';

const viewerFiles = [
  pathPolicy,
  'lib/ui/features/remote/view_models/remote_file_view_model.dart',
  'lib/ui/features/remote/views/remote_file_screen.dart',
  'lib/ui/features/remote/views/remote_image_screen.dart',
];

void main() {
  test('the image source policy imports no Flutter or platform code', () {
    final violations = [
      for (final MapEntry(key: path, value: uris) in importClosure(
        pathPolicy,
      ).entries)
        for (final uri in uris)
          if (!isAllowed(uri)) '$path: $uri',
    ];
    expect(violations, isEmpty);
  });

  test('the file viewer imports no other feature', () {
    final violations = [
      for (final path in viewerFiles)
        ...foreignFeatureImports(path, ownFeature: 'remote'),
    ];
    expect(violations, isEmpty);
  });
}
