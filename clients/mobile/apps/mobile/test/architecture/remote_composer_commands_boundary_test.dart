// Pins the CAN-3921 layering: the Remote Control repository composes the
// composer's slash-command delegate and the pairing-failure mapper (CAN-4426),
// so these delegates must not import any repository back
// (`apps/mobile/AGENTS.md`: "Dependencies point down"). Their error type comes
// from a lower-level contract instead.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const repositoryDelegates = [
  'lib/data/repositories/remote_composer_commands.dart',
  'lib/data/repositories/remote_pairing_failure.dart',
];

final _directive = RegExp(r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]''');

void main() {
  for (final delegate in repositoryDelegates) {
    test('$delegate imports no repository', () {
      final violations = [
        for (final (index, line) in File(delegate).readAsLinesSync().indexed)
          if (_directive.firstMatch(line)?.group(1) case final uri?
              when uri.contains('/repositories/'))
            '$delegate:${index + 1}: $uri',
      ];
      expect(violations, isEmpty);
    });
  }
}
