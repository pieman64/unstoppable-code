import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_invocables.dart';

void main() {
  group('CloudInvocableInventory.fromJson', () {
    test('maps optional plugin and member identities', () {
      final inventory = CloudInvocableInventory.fromJson({
        'rows': [
          {
            'name': 'review-deep-thing',
            'pluginName': 'docs-plugin',
            'memberName': 'review/deep:thing',
            'description': 'Reviews deeply',
            'insertText': r'$review-deep-thing ',
          },
          {'name': 'legacy', 'description': '', 'insertText': '/legacy '},
        ],
      });
      final [flattened, legacy] = inventory.rows;
      expect(flattened.pluginName, 'docs-plugin');
      expect(flattened.memberName, 'review/deep:thing');
      expect(flattened.insertText, r'$review-deep-thing ');
      expect(legacy.pluginName, isNull);
      expect(legacy.memberName, isNull);
    });

    test('rejects blank or non-string identities', () {
      for (final (key, value) in [
        ('pluginName', '  '),
        ('memberName', 3),
        ('pluginName', ''),
        ('pluginName', null),
        ('memberName', null),
      ]) {
        expect(
          () => CloudInvocableInventory.fromJson({
            'rows': [
              {
                'name': 'review',
                'description': '',
                'insertText': '/review ',
                key: value,
              },
            ],
          }),
          throwsFormatException,
          reason: '$key=$value',
        );
      }
    });

    test('maps rows, disabled reasons, and both enable ref forms', () {
      final inventory = CloudInvocableInventory.fromJson({
        'rows': [
          {
            'name': 'review',
            'description': 'Review changes',
            'insertText': '/review ',
          },
          {
            'name': 'locked',
            'description': '',
            'insertText': '',
            'unavailableReason': 'Sign in to use this skill.',
          },
          {
            'name': 'notes',
            'description': 'Release notes',
            'insertText': r'$notes ',
            'enableRef': {'sourceId': 'src', 'skillName': 'notes'},
          },
          {
            'name': 'deploy',
            'description': 'Deploy',
            'insertText': '/deploy:run ',
            'enableRef': {'marketplaceId': 'mk', 'pluginName': 'deploy'},
          },
        ],
        'defaultPluginSelections': {'collectionIds': <String>[]},
      });
      final rows = inventory.rows;
      expect(rows.map((row) => row.name), [
        'review',
        'locked',
        'notes',
        'deploy',
      ]);
      expect(rows[0].displayName, '/review');
      expect(rows[0].needsEnable, isFalse);
      expect(rows[1].unavailableReason, 'Sign in to use this skill.');
      expect(rows[2].enableRef, {'sourceId': 'src', 'skillName': 'notes'});
      expect(rows[2].insertion('/'), r'$notes ');
      expect(rows[3].enableRef, {
        'marketplaceId': 'mk',
        'pluginName': 'deploy',
      });
      // Only the workspace inventory carries project defaults.
      expect(inventory.defaultPluginSelections, isNull);
    });

    test('reads project defaults from the workspace inventory', () {
      final inventory = CloudInvocableInventory.fromJson({
        'rows': <Object>[],
        'defaultPluginSelections': {
          'collectionIds': ['c1'],
        },
      }, workspace: true);
      expect(inventory.defaultPluginSelections, {
        'collectionIds': ['c1'],
      });
      expect(
        CloudInvocableInventory.fromJson({
          'rows': <Object>[],
          'defaultPluginSelections': null,
        }, workspace: true).defaultPluginSelections,
        isNull,
      );
    });

    test('rejects answers outside the contract', () {
      for (final json in <Map<String, dynamic>>[
        {},
        {'version': 1, 'rows': 'nope'},
        {
          'rows': [
            {'name': '', 'description': '', 'insertText': '/x '},
          ],
        },
        {
          'rows': [
            {'name': 'x', 'insertText': '/x '},
          ],
        },
        {
          'rows': [
            {'name': 'x', 'description': '', 'insertText': ''},
          ],
        },
        {
          'rows': [
            {
              'name': 'x',
              'description': '',
              'insertText': '/x ',
              'enableRef': {'sourceId': 'src'},
            },
          ],
        },
      ]) {
        expect(
          () => CloudInvocableInventory.fromJson(json),
          throwsFormatException,
          reason: '$json',
        );
      }
      expect(
        () => CloudInvocableInventory.fromJson({
          'rows': <Object>[],
          'defaultPluginSelections': 'all',
        }, workspace: true),
        throwsFormatException,
      );
    });
  });

  group('withCapabilityEnableRef', () {
    test('adds a skill ref and keeps every other choice', () {
      final next = withCapabilityEnableRef(
        {
          'collectionIds': ['c1'],
          'bundleIds': ['c2', 'c1'],
          'skillRefs': [
            {'sourceId': 'a', 'skillName': 'one'},
          ],
          'pluginRefs': [
            {'marketplaceId': 'm', 'pluginName': 'p'},
          ],
          'mcpServerRefs': [
            {'serverId': 'mcp'},
          ],
          'mcpHttpAuthPreferences': {'mcp': 'oauth'},
        },
        {'sourceId': 'b', 'skillName': 'two'},
      );
      expect(next, {
        'collectionIds': ['c1', 'c2'],
        'skillRefs': [
          {'sourceId': 'a', 'skillName': 'one'},
          {'sourceId': 'b', 'skillName': 'two'},
        ],
        'pluginRefs': [
          {'marketplaceId': 'm', 'pluginName': 'p'},
        ],
        'mcpServerRefs': [
          {'serverId': 'mcp'},
        ],
        'mcpHttpAuthPreferences': {'mcp': 'oauth'},
      });
    });

    test('adds a plugin ref to an empty selection once', () {
      final ref = {'marketplaceId': 'm', 'pluginName': 'p'};
      final once = withCapabilityEnableRef(null, ref);
      expect(once, {
        'collectionIds': <Object?>[],
        'skillRefs': <Object?>[],
        'pluginRefs': [ref],
      });
      expect(withCapabilityEnableRef(once, ref), once);
    });

    test('refuses a selection it cannot read', () {
      expect(
        () => withCapabilityEnableRef(
          {'skillRefs': 'all'},
          {'sourceId': 's', 'skillName': 'n'},
        ),
        throwsFormatException,
      );
    });
  });
}
