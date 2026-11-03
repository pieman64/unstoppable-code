// Pins the CAN-3715 Activity boundary (`apps/mobile/AGENTS.md`: features do
// not import each other). The home shell owns tab navigation and account
// switching; the feed receives account facts and callbacks from it. Only the
// shell chrome that the feed screen and its filter sheet already imported
// stays allowed. The feed list measures its rows and corrects the scroll; a
// pure policy chooses the row that scroll offsets start at, so that choice is
// unit-tested without pumping. The live repository receives its
// data-sharing read by composition instead of a flag that switches it.
//
// Runs under `flutter test`, whose working directory is the package root.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'account_usage_boundary_test.dart' show foreignFeatureImports;

const feedRoot = 'lib/ui/features/feed';
const feedRepositoryPath = 'lib/data/repositories/feed_repository.dart';
const compositionRootPath = 'lib/main.dart';

/// Foreign-feature imports that predate CAN-3715, per file.
const allowedForeignImports = {
  'lib/ui/features/feed/views/feed_screen.dart': {
    'package:mobile/ui/features/organizations/views/widgets/org_lapse_state_view.dart',
    'package:mobile/ui/features/members/view_models/members_view_model.dart',
  },
  'lib/ui/features/feed/views/widgets/feed_filter_sheet.dart': {
    'package:mobile/ui/features/members/view_models/members_view_model.dart',
  },
};

void main() {
  test('feed files import no other feature beyond the existing chrome', () {
    final files = Directory(feedRoot)
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .map((file) => file.path)
        .toList();
    expect(files, isNotEmpty);
    final violations = [
      for (final path in files)
        for (final found in foreignFeatureImports(path, ownFeature: 'feed'))
          if (!(allowedForeignImports[path] ?? const <String>{}).contains(
            found.split(': ').last,
          ))
            found,
    ];
    expect(violations, isEmpty);
  });

  test('feed files that measure rows leave the anchor choice to a policy', () {
    final files = Directory(feedRoot)
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'));
    final measuring = [
      for (final file in files)
        if (file.readAsStringSync().contains('getOffsetToReveal')) file.path,
    ];
    expect(measuring, isNotEmpty);
    // The anchor is the first row the reader sees that the view model still
    // holds unchanged; a row is unchanged while its occurredAt is.
    final choices = [
      for (final path in measuring)
        for (final (index, line) in File(path).readAsLinesSync().indexed)
          if (line.contains('occurredAt')) '$path:${index + 1}: ${line.trim()}',
    ];
    expect(choices, isEmpty);
  });

  // `apps/mobile/AGENTS.md`: prefer composition over a boolean parameter that
  // switches behavior. Team and Personal Activity differ only in whether they
  // read organization data-sharing evidence, so the shell injects that read.
  test('the live feed repository has no flag that switches its reads', () {
    final source = File(feedRepositoryPath).readAsStringSync();
    final start = source.indexOf('final class HttpFeedRepository');
    expect(start, isNot(-1));
    final end = source.indexOf('\n}\n', start);
    expect(end, isNot(-1));
    final flags = [
      for (final line in source.substring(start, end).split('\n'))
        if (RegExp(r'\bbool\b').hasMatch(line)) line.trim(),
    ];
    expect(flags, isEmpty);
  });

  test('the feed repository builders take no flag that switches reads', () {
    final builders = RegExp(
      r'^FeedRepository (\w+)\(([^)]*)\)',
      multiLine: true,
    ).allMatches(File(compositionRootPath).readAsStringSync()).toList();
    expect(builders, isNotEmpty);
    final flags = [
      for (final builder in builders)
        if (RegExp(r'\bbool\b').hasMatch(builder.group(2)!))
          '${builder.group(1)}(${builder.group(2)!.trim()})',
    ];
    expect(flags, isEmpty);
  });
}
