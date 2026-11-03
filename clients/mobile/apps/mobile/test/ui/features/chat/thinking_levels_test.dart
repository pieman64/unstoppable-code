import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/thinking_levels.dart';

void main() {
  ModelOption option(
    String id, {
    String provider = 'claude',
    List<String>? supported,
    List<String>? legacy,
    Map<String, List<String>> harness = const {},
    bool isDefault = false,
  }) => ModelOption(
    id: id,
    label: id,
    provider: provider,
    kind: 'model',
    available: true,
    supportedThinkingLevels: supported,
    thinkingLevels: legacy,
    harnessThinkingLevels: harness,
    isDefault: isDefault,
  );

  const claude5 = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

  group('resolveThinkingLevels', () {
    test('uses canonical levels before legacy and provider levels', () {
      final catalog = [
        option('opus[1m]', supported: claude5, legacy: ['off', 'medium']),
      ];
      expect(resolveThinkingLevels(catalog, 'opus[1m]', 'claude'), claude5);
    });

    test('an explicit empty canonical set hides effort', () {
      final catalog = [
        option('sonnet', supported: const [], legacy: ['off', 'medium']),
      ];
      expect(resolveThinkingLevels(catalog, 'sonnet', 'claude'), isEmpty);
    });

    test('an absent canonical set falls back to legacy levels', () {
      final catalog = [
        option('sonnet', legacy: ['off', 'low', 'medium']),
      ];
      expect(resolveThinkingLevels(catalog, 'sonnet', 'claude'), [
        'off',
        'low',
        'medium',
      ]);
    });

    test('absent legacy levels fall back to the provider', () {
      for (final provider in ['claude', 'codex']) {
        final catalog = [option('model', provider: provider)];
        expect(
          resolveThinkingLevels(catalog, 'model', provider),
          allOf(isNotEmpty, providerFallbackThinkingLevels(provider)),
          reason: provider,
        );
      }
    });

    test('an explicit empty legacy set hides effort', () {
      for (final provider in ['claude', 'codex']) {
        final catalog = [option('model', provider: provider, legacy: const [])];
        expect(
          resolveThinkingLevels(catalog, 'model', provider),
          isEmpty,
          reason: provider,
        );
      }
    });

    test('a model missing from the catalog uses the provider levels', () {
      expect(resolveThinkingLevels(const [], 'gpt-5-codex', 'codex'), [
        'off',
        'medium',
        'high',
        'xhigh',
      ]);
    });

    test('without a model id the declared default row stands in', () {
      final catalog = [
        option('haiku', supported: ['off', 'medium']),
        option('opus', supported: claude5, isDefault: true),
      ];
      expect(resolveThinkingLevels(catalog, null, 'claude'), claude5);
      expect(resolveThinkingLevels(catalog, '', 'claude'), claude5);
    });

    test('a harness choice declares its own levels for that harness', () {
      final catalog = [
        option(
          'gateway-model',
          provider: 'codex',
          supported: ['low', 'medium', 'high'],
          harness: const {'opencode': []},
        ),
      ];
      expect(resolveThinkingLevels(catalog, 'gateway-model', 'opencode'), []);
      expect(resolveThinkingLevels(catalog, 'gateway-model', 'codex'), [
        'low',
        'medium',
        'high',
      ]);
    });

    test('orders declared levels canonically and drops duplicates', () {
      final catalog = [
        option('gpt-6-astra', supported: ['ultra', 'low', 'high', 'low']),
      ];
      expect(resolveThinkingLevels(catalog, 'gpt-6-astra', 'codex'), [
        'low',
        'high',
        'ultra',
      ]);
    });
  });

  group('providerFallbackThinkingLevels', () {
    test('matches the protocol for each provider', () {
      for (final provider in ['unknown', 'cursor', 'copilot', 'opencode']) {
        expect(
          providerFallbackThinkingLevels(provider),
          isEmpty,
          reason: provider,
        );
      }
      expect(providerFallbackThinkingLevels('codex'), [
        'off',
        'medium',
        'high',
        'xhigh',
      ]);
      for (final provider in ['claude', 'ollama', 'other', null]) {
        expect(providerFallbackThinkingLevels(provider), [
          'off',
          'medium',
          'high',
          'xhigh',
          'max',
        ], reason: '$provider');
      }
    });
  });

  group('clampThinkingLevelTo', () {
    test('keeps a supported level and clamps down otherwise', () {
      const supported = ['off', 'medium', 'xhigh'];
      expect(clampThinkingLevelTo('medium', supported), 'medium');
      // `max` is unsupported; the nearest supported tier at or below wins.
      expect(clampThinkingLevelTo('max', supported), 'xhigh');
      expect(clampThinkingLevelTo('high', supported), 'medium');
    });

    test('keeps low when declared and clamps it down otherwise', () {
      expect(clampThinkingLevelTo('low', claude5), 'low');
      expect(clampThinkingLevelTo('low', ['off', 'medium']), 'off');
      expect(clampThinkingLevelTo('medium', ['off', 'low', 'high']), 'low');
    });

    test('uses the weakest supported tier when nothing below is supported', () {
      expect(clampThinkingLevelTo('medium', ['xhigh', 'max']), 'xhigh');
      expect(clampThinkingLevelTo('off', ['low', 'high']), 'low');
      expect(clampThinkingLevelTo('off', []), 'off');
    });
  });

  group('ModelOption parsing', () {
    test('keeps low, absent and empty level sets apart', () {
      final row = ModelOption.fromJson({
        'id': 'opus[1m]',
        'supportedThinkingLevels': claude5,
        'thinkingLevels': ['off', 'low', 'turbo'],
        'harnessChoices': [
          {'harness': 'claude'},
          {'harness': 'opencode', 'supportedThinkingLevels': <String>[]},
        ],
      });
      expect(row.supportedThinkingLevels, claude5);
      expect(row.thinkingLevels, ['off', 'low']);
      expect(row.harnessThinkingLevels, {'opencode': <String>[]});

      final empty = ModelOption.fromJson({
        'id': 'cursor',
        'supportedThinkingLevels': <String>[],
        'thinkingLevels': <String>[],
      });
      expect(empty.supportedThinkingLevels, isEmpty);
      expect(empty.thinkingLevels, isEmpty);

      final absent = ModelOption.fromJson({'id': 'older-host'});
      expect(absent.supportedThinkingLevels, isNull);
      expect(absent.thinkingLevels, isNull);
      expect(absent.harnessThinkingLevels, isEmpty);
    });
  });
}
