import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';

void main() {
  const github = ComposerPluginItem(
    kind: ComposerPluginKind.plugin,
    ref: {'marketplaceId': 'market', 'pluginName': 'github'},
    name: 'GitHub',
  );
  const notes = ComposerPluginItem(
    kind: ComposerPluginKind.skill,
    ref: {'sourceId': 'src', 'skillName': 'notes'},
    name: 'Notes',
  );
  const catalog = ComposerPluginCatalog(items: [github, notes]);

  late List<Map<String, Object?>> saves;
  late Future<Map<String, Object?>> Function(Map<String, Object?>) answer;
  late Future<Map<String, Object?>> Function() selections;
  late Future<ComposerPluginCatalog> Function() loadCatalog;

  ComposerPluginsController controller({String? providerType}) =>
      ComposerPluginsController(
        ComposerPluginsSource(
          providerType: () => providerType,
          loadCatalog: () => loadCatalog(),
          loadSelections: () => selections(),
          save: (next) {
            saves.add(next);
            return answer(next);
          },
          selectedCount: () => null,
        ),
      );

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  setUp(() {
    saves = [];
    answer = (next) async => next;
    selections = () async => {
      'collectionIds': ['kit'],
    };
    loadCatalog = () async => catalog;
  });

  test('loads the catalog and selection, then saves a toggle', () async {
    final plugins = controller();
    expect(plugins.status, ComposerPluginsStatus.loading);
    await settle();
    expect(plugins.status, ComposerPluginsStatus.ready);
    expect(plugins.isSelected(github), isFalse);

    await plugins.toggle(github);
    expect(saves.single, {
      'collectionIds': ['kit'],
      'skillRefs': <Object?>[],
      'pluginRefs': [github.ref],
    });
    expect(plugins.isSelected(github), isTrue);
    expect(plugins.errorFor(github), isNull);
    plugins.dispose();
  });

  test('a failed load offers Retry and never writes', () async {
    selections = () async => throw StateError('unknown');
    final plugins = controller();
    await settle();
    expect(plugins.status, ComposerPluginsStatus.failed);
    await plugins.toggle(github);
    expect(saves, isEmpty);

    selections = () async => const {};
    plugins.load();
    await settle();
    expect(plugins.status, ComposerPluginsStatus.ready);
    plugins.dispose();
  });

  test('a malformed selection is unknown, not empty', () async {
    selections = () async => {'pluginRefs': 'oops'};
    final plugins = controller();
    await settle();
    expect(plugins.status, ComposerPluginsStatus.failed);
    plugins.dispose();
  });

  test('a rejected write restores the previous selection', () async {
    answer = (_) async => throw StateError('rejected');
    final plugins = controller();
    await settle();
    await plugins.toggle(github);
    expect(plugins.isSelected(github), isFalse);
    expect(plugins.errorFor(github), 'Could not change GitHub. Try again.');
    // Only the row that failed reports it.
    expect(plugins.errorFor(notes), isNull);

    // The next toggle clears the error.
    answer = (next) async => next;
    await plugins.toggle(notes);
    expect(plugins.errorFor(github), isNull);
    expect(plugins.errorFor(notes), isNull);
    expect(plugins.isSelected(notes), isTrue);
    plugins.dispose();
  });

  test('an accepted answer that pruned the row is reported', () async {
    answer = (_) async => const {
      'collectionIds': ['kit'],
    };
    final plugins = controller();
    await settle();
    await plugins.toggle(github);
    expect(plugins.isSelected(github), isFalse);
    expect(plugins.errorFor(github), 'Could not change GitHub. Try again.');
    plugins.dispose();
  });

  test('one write at a time: rows wait for the pending write', () async {
    final pending = Completer<Map<String, Object?>>();
    answer = (_) => pending.future;
    final plugins = controller();
    await settle();
    final first = plugins.toggle(github);
    expect(plugins.saving, github);
    expect(plugins.isSelected(github), isTrue);
    await plugins.toggle(notes);
    expect(saves, hasLength(1));

    pending.complete(saves.single);
    await first;
    expect(plugins.saving, isNull);
    plugins.dispose();
  });

  test('a write that lands after the sheet closed changes nothing', () async {
    final pending = Completer<Map<String, Object?>>();
    answer = (_) => pending.future;
    final plugins = controller();
    await settle();
    final write = plugins.toggle(github);
    plugins.dispose();
    pending.completeError(StateError('late'));
    await write;
  });

  test('a late load does not replace a newer one', () async {
    final slow = Completer<ComposerPluginCatalog>();
    loadCatalog = () => slow.future;
    final plugins = controller();
    loadCatalog = () async => const ComposerPluginCatalog(items: [notes]);
    plugins.load();
    await settle();
    slow.complete(catalog);
    await settle();
    expect(plugins.catalog.items, [notes]);
    plugins.dispose();
  });

  group('provider support', () {
    const codexOnly = ComposerPluginItem(
      kind: ComposerPluginKind.plugin,
      ref: {'marketplaceId': 'market', 'pluginName': 'codex-tools'},
      name: 'Codex tools',
      claudeSupported: false,
      codexSupported: true,
    );

    setUp(() {
      loadCatalog = () async =>
          const ComposerPluginCatalog(items: [codexOnly, github]);
    });

    test('a Claude chat cannot turn on a plugin only Codex supports', () async {
      final plugins = controller(providerType: 'claude');
      await settle();
      expect(plugins.isSupported(codexOnly), isFalse);
      expect(plugins.canToggle(codexOnly), isFalse);
      await plugins.toggle(codexOnly);
      expect(saves, isEmpty);
      expect(plugins.isSelected(codexOnly), isFalse);

      expect(plugins.canToggle(github), isTrue);
      await plugins.toggle(github);
      expect(saves.single['pluginRefs'], [github.ref]);
      plugins.dispose();
    });

    test('a selected unsupported plugin can still be turned off', () async {
      selections = () async => {
        'pluginRefs': [codexOnly.ref],
      };
      final plugins = controller(providerType: 'claude');
      await settle();
      expect(plugins.isSelected(codexOnly), isTrue);
      expect(plugins.canToggle(codexOnly), isTrue);
      await plugins.toggle(codexOnly);
      expect(saves.single['pluginRefs'], isEmpty);
      expect(plugins.canToggle(codexOnly), isFalse);
      await plugins.toggle(codexOnly);
      expect(saves, hasLength(1));
      plugins.dispose();
    });

    for (final providerType in ['codex', 'cursor', null]) {
      test('a ${providerType ?? 'provider-less'} chat turns it on', () async {
        final plugins = controller(providerType: providerType);
        await settle();
        expect(plugins.canToggle(codexOnly), isTrue);
        await plugins.toggle(codexOnly);
        expect(saves.single['pluginRefs'], [codexOnly.ref]);
        plugins.dispose();
      });
    }
  });
}
