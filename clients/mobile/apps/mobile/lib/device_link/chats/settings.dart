import 'package:mobile/data/models/chat_message.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';
import 'model_registry.dart';
import 'default_model.dart';

final class DeviceChatSettings {
  DeviceChatSettings(this.ipc);
  final DesktopIpc ipc;
  List<ModelOption> models = [];
  ProviderAvailability? providerAvailability;
  String? scopeKey,
      executionHarness,
      modelLabel,
      defaultModelId,
      defaultThinkingLevel;
  bool modelRoutingSupported = false, modelHarnessLocked = false;
  bool loading = false, loaded = false;
  int _generation = 0;
  Future<void>? _read;
  void _clear() {
    models = [];
    providerAvailability = null;
    executionHarness = modelLabel = defaultModelId = defaultThinkingLevel =
        null;
    modelRoutingSupported = modelHarnessLocked = loaded = false;
  }

  void invalidate() {
    _generation++;
    _read = null;
    loading = false;
    scopeKey = null;
    _clear();
  }

  Future<void> load(DeviceChatRef ref) {
    if (scopeKey == ref.key && _read != null) return _read!;
    if (scopeKey != ref.key) _clear();
    scopeKey = ref.key;
    loading = true;
    final generation = ++_generation;
    late final Future<void> pending;
    pending = _load(ref, generation).whenComplete(() {
      if (identical(_read, pending)) {
        _read = null;
        loading = false;
      }
    });
    _read = pending;
    return pending;
  }

  Future<Map<String, dynamic>?> _projection(DeviceChatRef ref) async {
    try {
      final result = deviceLinkObject(
        deviceChatDto(
          await ipc.invoke('desktop:session-snapshot', [
            {
              'workspaceLocalId': ref.projectId,
              'worktreeLocalId': ref.worktreeId,
              'includeChatSummaries': true,
            },
          ]),
        ),
      );
      return (result['chatSummaries'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .where(
            (row) =>
                row['scope'] == 'worktree' &&
                row['workspaceLocalId'] == ref.projectId &&
                row['worktreeLocalId'] == ref.worktreeId &&
                row['chatId'] == ref.id,
          )
          .firstOrNull;
    } catch (_) {
      // This optional, existing read must never break older registry-only hosts.
      return null;
    }
  }

  Future<void> _load(DeviceChatRef ref, int generation) async {
    final values = await Future.wait<Object?>([
      ipc.invoke('model-registry:get'),
      _projection(ref),
    ]);
    final response = deviceLinkObject(deviceChatDto(values[0]));
    final projection = values[1] as Map<String, dynamic>?;
    final projectedRows = projection?['availableModels'];
    final next = projectedRows is List
        ? [
            for (final row in projectedRows)
              ModelOption.fromJson(deviceLinkObject(row)),
          ]
        : deviceRegistryModels(response);
    if (next.any((row) => row.id.isEmpty || row.provider.isEmpty)) {
      throw const FormatException('Invalid model catalog');
    }
    final savedDefault = await readDeviceDefaultModel(ipc, ref, response);
    final defaultId =
        next.where((row) => row.isDefault).firstOrNull?.id ??
        savedDefault?.modelId;
    if (generation != _generation) return;
    models = next;
    defaultModelId = next.any((row) => row.id == defaultId) ? defaultId : null;
    defaultThinkingLevel =
        defaultModelId != null && defaultModelId == savedDefault?.modelId
        ? savedDefault?.thinkingLevel
        : null;
    providerAvailability = projection?['providerAvailability'] is Map
        ? ProviderAvailability.fromJson(
            deviceLinkObject(projection!['providerAvailability']),
          )
        : null;
    executionHarness = projection?['executionHarness'] as String?;
    modelLabel = projection?['modelLabel'] as String?;
    modelRoutingSupported = projection?['modelRoutingSupported'] == true;
    modelHarnessLocked = projection?['modelHarnessLocked'] == true;
    loaded = true;
  }

  Future<void> command(DeviceChatRef ref, Map<String, dynamic> command) async {
    final response = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('chat:command', [
          {
            'schemaVersion': 1,
            'commandId': chatId(),
            ...ref.scope,
            'command': command,
          },
        ]),
      ),
    );
    if (!['applied', 'already_applied'].contains(response['outcome'])) {
      throw const DeviceLinkException(
        'The computer could not complete this action. Refresh and try again.',
      );
    }
  }

  Future<void> selectModel(DeviceChatRef ref, ModelOption choice) async {
    if (scopeKey != ref.key ||
        !models.any((row) => row.id == choice.id && row.available)) {
      throw const DeviceLinkException(
        'Refresh model choices before selecting a model.',
      );
    }
    await command(ref, {
      'type': 'chat.set_model',
      'tabId': ref.id,
      'model': choice.id,
      'providerType': choice.provider,
      if (choice.harness != null) 'executionHarness': choice.harness,
    });
  }

  Future<void> selectAuto(DeviceChatRef ref) {
    if (scopeKey != ref.key || !modelRoutingSupported) {
      throw const DeviceLinkException('Auto is not available for this chat.');
    }
    return patch(ref, {'modelSelectionMode': 'auto'});
  }

  Future<void> patch(DeviceChatRef ref, Map<String, dynamic> patch) => command(
    ref,
    {'type': 'chat.patch_tab_settings', 'tabId': ref.id, 'patch': patch},
  );
}
