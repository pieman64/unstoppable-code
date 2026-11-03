// Pins the CAN-3636 feature boundary: Account shows the paired desktop's
// plan usage through the neutral `ProviderUsageSource`, which the app
// composition root backs with Remote Control. Account's usage files and the
// contract itself import no other feature. The provider usage capability and
// command live in their own data unit, not in the Remote Control repository
// (`apps/mobile/AGENTS.md`: that file takes no new responsibilities).
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const usageSourceContract = 'lib/ui/core/provider_usage_source.dart';

const remoteControlRepository =
    'lib/data/repositories/remote_control_repository.dart';
const providerUsageCommands =
    'lib/data/repositories/remote_provider_usage_commands.dart';

const accountUsageRoots = [
  'lib/ui/features/account/view_models/usage_limits_policy.dart',
  'lib/ui/features/account/view_models/usage_limits_view_model.dart',
  'lib/ui/features/account/views/usage_limits_row.dart',
  'lib/ui/features/account/views/usage_limits_screen.dart',
  'lib/ui/features/account/views/widgets/usage_limit_meter.dart',
  'lib/ui/features/account/views/widgets/usage_limit_window_card.dart',
];

final _directive = RegExp(r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]''');

/// Imports of [path] that reach a feature other than [ownFeature] (any
/// feature when null).
List<String> foreignFeatureImports(String path, {String? ownFeature}) {
  final found = <String>[];
  for (final (index, line) in File(path).readAsLinesSync().indexed) {
    final uri = _directive.firstMatch(line)?.group(1);
    if (uri == null) continue;
    final feature = RegExp(r'features/([^/]+)/').firstMatch(uri)?.group(1);
    if (feature != null && feature != ownFeature) {
      found.add('$path:${index + 1}: $uri');
    }
  }
  return found;
}

void main() {
  test('the usage source contract imports no feature', () {
    expect(File(usageSourceContract).existsSync(), isTrue);
    expect(foreignFeatureImports(usageSourceContract), isEmpty);
  });

  test('Account usage files import no other feature', () {
    final violations = [
      for (final path in accountUsageRoots)
        ...foreignFeatureImports(path, ownFeature: 'account'),
    ];
    expect(violations, isEmpty);
  });

  test('the provider usage capability and command stay out of the Remote '
      'Control repository', () {
    final usageWire = RegExp(r'''['"](?:portal\.)?provider_usage''');
    final violations = [
      for (final (index, line) in File(
        remoteControlRepository,
      ).readAsLinesSync().indexed)
        if (usageWire.hasMatch(line)) '$remoteControlRepository:${index + 1}',
    ];
    expect(violations, isEmpty);
    expect(
      File(providerUsageCommands).readAsStringSync(),
      contains("'portal.provider_usage.refresh'"),
    );
  });
}
