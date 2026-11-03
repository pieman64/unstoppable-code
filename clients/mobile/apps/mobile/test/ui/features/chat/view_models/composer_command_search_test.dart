import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_search.dart';

/// Runs the slash search vectors shared with the TypeScript ranker. The
/// expectations are hand-reviewed against the contract; never regenerate
/// them from either implementation.
void main() {
  final vectors =
      jsonDecode(
            File('test/fixtures/slash-search-vectors.json').readAsStringSync(),
          )
          as Map<String, dynamic>;

  test('uses a known vector version', () {
    expect(vectors['version'], 2);
  });

  group('search vectors', () {
    for (final vector in vectors['search'] as List<dynamic>) {
      final data = vector as Map<String, dynamic>;
      test(data['case'], () {
        final rows = [
          for (final row in data['rows'] as List<dynamic>)
            row as Map<String, dynamic>,
        ];
        final ranked = searchComposerItems(
          rows,
          data['query'] as String,
          (row) => (
            name: row['name'] as String,
            displayName: row['displayName'] as String?,
            description: row['description'] as String?,
            category: row['category'] as String?,
            namespace: row['namespace'] as String?,
            memberName: row['memberName'] as String?,
            available: row['section'] == 'available',
          ),
        );
        expect([for (final row in ranked) row['id']], data['expected']);
      });
    }
  });

  group('limit vectors', () {
    for (final vector in vectors['limit'] as List<dynamic>) {
      final data = vector as Map<String, dynamic>;
      test(data['case'], () {
        final rows = [
          for (final row in data['rows'] as List<dynamic>)
            row as Map<String, dynamic>,
        ];
        final limits = data['limits'] as Map<String, dynamic>?;
        String group(Map<String, dynamic> row) => row['group'] as String;
        // A non-integer limit is invalid, as in the TypeScript policy.
        int? limit(String key) => switch (limits?[key]) {
          final int value => value,
          _ => null,
        };
        final before = jsonEncode(rows);
        final result = data['expanded'] == true
            ? (visible: List.of(rows), hiddenCount: 0)
            : limitSlashResults(
                rows,
                group,
                total: limit('total'),
                perGroup: limit('perGroup'),
              );
        expect(jsonEncode(rows), before);
        final expected = data['expected'] as Map<String, dynamic>;
        expect([
          for (final row in result.visible) row['id'],
        ], expected['visible']);
        expect(result.hiddenCount, expected['hiddenCount']);
        final runs = data['runs'] as List<dynamic>?;
        if (runs != null) {
          expect([
            for (final run in groupContiguousRuns(result.visible, group))
              {
                'key': run.key,
                'occurrence': run.occurrence,
                'rows': [for (final row in run.rows) row['id']],
              },
          ], runs);
        }
      });
    }
  });

  test('accepts one edit and rejects two', () {
    expect(isOneEditApart('reveiw', 'review'), isTrue);
    expect(isOneEditApart('revieww', 'review'), isTrue);
    expect(isOneEditApart('reviw', 'review'), isTrue);
    expect(isOneEditApart('revwie', 'review'), isFalse);
    expect(isOneEditApart('review', 'review'), isFalse);
  });
}
