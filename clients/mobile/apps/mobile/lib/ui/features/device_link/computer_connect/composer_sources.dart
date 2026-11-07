import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/device_link/chats/composer.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import '../chats_view_model.dart';

/// Adapts the transport-neutral composer to one selected chat and connection.
/// Every async continuation checks the selection generation, including when a
/// reconnect reopens the same chat on another computer with matching ids.
final class DeviceComposerSources extends ChangeNotifier {
  DeviceComposerSources(this.model)
    : repository = DeviceChatComposerRepository(model.chats.ipc) {
    _events = model.chats.ipc.events.listen((event) {
      if (event['name'] != 'ipc.push') return;
      final push = event['payload'];
      if (push is Map && push['channel'] == 'invocable-inventory:changed') {
        _inventoryRevision++;
        notifyListeners();
      }
    });
  }
  final DeviceChatsViewModel model;
  final DeviceChatComposerRepository repository;
  late final StreamSubscription<Map<String, dynamic>> _events;
  int _inventoryRevision = 0;
  ({Object scope, bool unsettled})? _inventoryState;
  bool _disposed = false;

  String? get _harness => model.settings.scopeKey == model.state?.ref.key
      ? model.settings.executionHarness
      : null;

  ({ComposerCommandSource commands, ComposerPluginsSource plugins})? current() {
    final state = model.state;
    if (state == null || state.closed || !model.chats.ready) return null;
    final ref = state.ref;
    final generation = model.chats.selectionGeneration;
    final harness = _harness;
    final modelId = state.tab['model'];
    final tabHarness = state.tab['executionHarness'];
    final scope = (ref.key, generation, harness, modelId, tabHarness);
    bool current() =>
        !_disposed &&
        model.online &&
        model.chats.ready &&
        model.chats.selectionGeneration == generation &&
        model.state?.ref.key == ref.key &&
        model.state?.closed == false &&
        model.state?.tab['model'] == modelId &&
        model.state?.tab['executionHarness'] == tabHarness;
    void checkTarget() {
      if (!current()) {
        throw const DeviceLinkException(
          'The chat changed. Close the picker and open it again.',
        );
      }
    }

    String inventoryHarness() {
      checkTarget();
      final liveHarness = _harness;
      if (liveHarness == null) {
        throw const DeviceLinkException(
          "Couldn't load chat choices. Try again once the chat has loaded.",
        );
      }
      return liveHarness;
    }

    void sameModel(DeviceComposerSnapshot value) {
      if (value.tab['model'] != modelId ||
          value.tab['executionHarness'] != tabHarness) {
        throw const DeviceLinkException(
          'The model changed. Close the picker and open it again.',
        );
      }
    }

    return (
      commands: ComposerCommandSource(
        scope: scope,
        revision: () => (
          _inventoryRevision,
          jsonEncode(model.state?.tab['pluginSelections']),
        ),
        load: () async {
          final provider = inventoryHarness();
          final result = await repository.inventory(provider);
          if (inventoryHarness() != provider) {
            throw const DeviceLinkException('The chat changed. Try again.');
          }
          _inventoryState = (scope: scope, unsettled: result.unsettled);
          return result.commands;
        },
        unsettled: () =>
            _inventoryState?.scope == scope &&
            _inventoryState?.unsettled == true,
      ),
      plugins: ComposerPluginsSource(
        providerType: () => _harness,
        readOnlyReason: devicePluginSelectionsReadOnly,
        loadCatalog: () async {
          checkTarget();
          final catalog = await repository.catalog();
          checkTarget();
          return catalog;
        },
        loadSelections: () async {
          checkTarget();
          final snapshot = await repository.snapshot(ref);
          checkTarget();
          sameModel(snapshot);
          return snapshot.selections;
        },
        save: (_) async {
          checkTarget();
          throw const DeviceLinkException(devicePluginSelectionsReadOnly);
        },
        selectedCount: () {
          if (!current()) return null;
          final selections = model.state?.tab['pluginSelections'];
          if (selections == null) return 0;
          return selections is Map<String, Object?>
              ? countPluginSelections(selections)
              : null;
        },
      ),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_events.cancel());
    super.dispose();
  }
}
