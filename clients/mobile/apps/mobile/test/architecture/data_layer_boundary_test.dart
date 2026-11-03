// Pins the mobile layering (`apps/mobile/AGENTS.md`: "Dependencies point
// down"): the data layer serves every feature, so nothing under `lib/data`
// imports UI. Pure rules that several features share, such as the workspace
// context scope (CAN-4429), live there instead of inside one feature.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

final _directive = RegExp(r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]''');

void main() {
  test('lib/data imports no UI', () {
    final violations = [
      for (final file in Directory('lib/data').listSync(recursive: true))
        if (file is File && file.path.endsWith('.dart'))
          for (final (index, line) in file.readAsLinesSync().indexed)
            if (_directive.firstMatch(line)?.group(1) case final uri?
                when uri.startsWith('package:mobile/ui/'))
              '${file.path}:${index + 1}: $uri',
    ];
    expect(violations, isEmpty);
  });
}
