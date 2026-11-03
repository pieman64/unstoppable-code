import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_plugins.dart';

void main() {
  const github = ComposerPluginItem(
    kind: ComposerPluginKind.plugin,
    ref: {'marketplaceId': 'market', 'pluginName': 'github'},
    name: 'GitHub',
  );
  const kit = ComposerPluginItem(
    kind: ComposerPluginKind.collection,
    ref: {'id': 'kit'},
    name: 'Kit',
  );
  const linear = ComposerPluginItem(
    kind: ComposerPluginKind.mcpServer,
    ref: {'serverId': 'linear', 'configId': 'default'},
    name: 'Linear',
  );

  group('ComposerPluginCatalog.fromJson', () {
    test('reads every group in display order and skips rows without ids', () {
      final catalog = ComposerPluginCatalog.fromJson({
        'mcpServers': [
          {'serverId': 'linear', 'configId': 'default', 'configName': 'Prod'},
        ],
        'skills': [
          {'sourceId': 'src', 'skillName': 'notes', 'name': 'Notes'},
          {'sourceId': 'src'},
          'not a row',
        ],
        'plugins': [
          {
            'marketplaceId': 'market',
            'pluginName': 'github',
            'name': 'GitHub',
            'description': 'Checks',
          },
        ],
        'collections': [
          {'id': 'kit', 'name': 'Kit'},
        ],
      });
      expect(catalog.items.map((item) => item.key), [
        'collection:kit',
        'plugin:market/github',
        'skill:src/notes',
        'mcpServer:linear/default',
      ]);
      expect(
        catalog.itemsOf(ComposerPluginKind.plugin).single.description,
        'Checks',
      );
      // An MCP row without a server name falls back to its config name.
      expect(catalog.itemsOf(ComposerPluginKind.mcpServer).single.name, 'Prod');
    });

    test('keeps each plugin row\'s provider support flags', () {
      final plugins = ComposerPluginCatalog.fromJson({
        'plugins': [
          {
            'marketplaceId': 'market',
            'pluginName': 'codex-tools',
            'claudeSupported': false,
            'codexSupported': true,
          },
          // An older desktop sends no flags; a malformed flag is unknown.
          {
            'marketplaceId': 'market',
            'pluginName': 'legacy',
            'claudeSupported': 'yes',
          },
        ],
      }).items;
      expect(plugins.first.claudeSupported, isFalse);
      expect(plugins.first.codexSupported, isTrue);
      expect(plugins.last.claudeSupported, isNull);
      expect(plugins.last.codexSupported, isNull);
    });

    test('treats a missing group as empty and rejects malformed answers', () {
      expect(
        ComposerPluginCatalog.fromJson(<String, dynamic>{}).items,
        isEmpty,
      );
      expect(() => ComposerPluginCatalog.fromJson(null), throwsFormatException);
      expect(
        () => ComposerPluginCatalog.fromJson({'plugins': 'nope'}),
        throwsFormatException,
      );
    });
  });

  group('plugin selections', () {
    const selections = <String, Object?>{
      'bundleIds': ['legacy'],
      'collectionIds': ['kit'],
      'skillRefs': [
        {'sourceId': 'src', 'skillName': 'notes'},
      ],
      'pluginRefs': <Object?>[],
      'mcpHttpAuthPreferences': [
        {'handler': 'oauth'},
      ],
      'unresolvedCapabilities': [
        {'id': 'pending'},
      ],
    };

    test('turning a row on keeps every other choice and its metadata', () {
      final next = withPluginSelection(selections, github, on: true);
      expect(next, {
        'collectionIds': ['kit', 'legacy'],
        'skillRefs': [
          {'sourceId': 'src', 'skillName': 'notes'},
        ],
        'pluginRefs': [github.ref],
        'mcpHttpAuthPreferences': [
          {'handler': 'oauth'},
        ],
        'unresolvedCapabilities': [
          {'id': 'pending'},
        ],
      });
      expect(withPluginSelection(next, github, on: true), next);
      expect(pluginSelectionsContain(next, github), isTrue);
    });

    test('turning rows off removes only them, including legacy ids', () {
      final next = withPluginSelection(
        withPluginSelection(selections, kit, on: false),
        const ComposerPluginItem(
          kind: ComposerPluginKind.collection,
          ref: {'id': 'legacy'},
          name: 'Legacy',
        ),
        on: false,
      );
      expect(next['collectionIds'], isEmpty);
      expect(next['skillRefs'], selections['skillRefs']);
      expect(next.containsKey('bundleIds'), isFalse);
    });

    test('MCP refs are added only when a server is chosen', () {
      expect(
        normalizePluginSelections(const {}).containsKey('mcpServerRefs'),
        isFalse,
      );
      final next = withPluginSelection(const {}, linear, on: true);
      expect(next['mcpServerRefs'], [linear.ref]);
      expect(countPluginSelections(next), 1);
    });

    test('counts every explicit choice once', () {
      expect(countPluginSelections(selections), 3);
      expect(countPluginSelections(const {}), 0);
    });

    test('a malformed list is never rewritten', () {
      expect(
        () => withPluginSelection({'pluginRefs': 'oops'}, github, on: true),
        throwsFormatException,
      );
    });

    test('a malformed list has no count', () {
      expect(countPluginSelections({'pluginRefs': 'oops'}), isNull);
      expect(countPluginSelections({'collectionIds': 3}), isNull);
    });
  });

  group('provider support', () {
    // The desktop Plugins modal rule (`pluginSelectorScope.ts`).
    test('maps a chat provider to the support flag its plugins need', () {
      expect(composerPluginProviderOf('claude'), ComposerPluginProvider.claude);
      expect(composerPluginProviderOf('ollama'), ComposerPluginProvider.claude);
      expect(composerPluginProviderOf('codex'), ComposerPluginProvider.codex);
      for (final open in ['cursor', 'copilot', 'opencode', 'other', null]) {
        expect(composerPluginProviderOf(open), isNull, reason: open);
      }
    });

    test('a plugin needs the flag of the chat provider; a missing flag '
        'or provider allows it', () {
      const codexOnly = ComposerPluginItem(
        kind: ComposerPluginKind.plugin,
        ref: {'marketplaceId': 'market', 'pluginName': 'codex-tools'},
        name: 'Codex tools',
        claudeSupported: false,
        codexSupported: true,
      );
      expect(codexOnly.supports(ComposerPluginProvider.claude), isFalse);
      expect(codexOnly.supports(ComposerPluginProvider.codex), isTrue);
      expect(codexOnly.supports(null), isTrue);
      for (final provider in [...ComposerPluginProvider.values, null]) {
        expect(github.supports(provider), isTrue);
        expect(kit.supports(provider), isTrue);
      }
    });
  });
}
