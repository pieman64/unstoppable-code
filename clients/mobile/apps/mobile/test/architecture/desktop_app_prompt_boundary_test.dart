import 'dart:io';

// CAN-4424: cross-feature prompt coordination belongs to app composition.
// Controllers depend on presentation contracts, never their views.

import 'package:flutter_test/flutter_test.dart';

import 'account_usage_boundary_test.dart' show foreignFeatureImports;
import 'chat_boundary_test.dart' show dartFilesUnder, violations;

void main() {
  test('desktop app prompt imports no other feature', () {
    final files = dartFilesUnder('lib/ui/features/desktop_app').toList();
    expect(files, isNotEmpty);
    expect([
      for (final file in files)
        ...foreignFeatureImports(file.path, ownFeature: 'desktop_app'),
    ], isEmpty);
  });

  test('desktop app prompt view models import no views', () {
    final files = dartFilesUnder(
      'lib/ui/features/desktop_app/view_models',
    ).toList();
    expect(files, isNotEmpty);
    expect(violations(files, ['/views/']), isEmpty);
  });

  test('cloud chat composes prompts without feature imports', () {
    expect(
      violations(
        [File('lib/ui/features/cloud/views/cloud_chat_screen.dart')],
        ['features/desktop_app/', 'features/satisfaction/'],
      ),
      isEmpty,
    );
  });

  test('account and pairing binding belongs to app composition', () {
    expect(
      File(
        'lib/ui/features/home/views/desktop_app_prompt_binding.dart',
      ).existsSync(),
      isFalse,
    );
    expect(
      File('lib/app/desktop_app_prompt_binding.dart').existsSync(),
      isTrue,
    );
  });
}
