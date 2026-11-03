// Pins the `apps/mobile/AGENTS.md` rule that features do not import each
// other for Developer Options: its reference screens compose the design
// system and core UI, never another feature's widgets.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const developerOptionsRoot = 'lib/ui/features/developer_options';

final _directive = RegExp(r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]''');
final _feature = RegExp(r'features/([^/]+)/');

void main() {
  test('Developer Options imports no other feature', () {
    final files = Directory(developerOptionsRoot)
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();
    expect(files, isNotEmpty);
    final violations = [
      for (final file in files)
        for (final (index, line) in file.readAsLinesSync().indexed)
          if (_directive.firstMatch(line)?.group(1) case final uri?)
            if (_feature.firstMatch(uri)?.group(1) case final feature?)
              if (feature != 'developer_options')
                '${file.path}:${index + 1}: $uri',
    ];
    expect(violations, isEmpty);
  });
}
