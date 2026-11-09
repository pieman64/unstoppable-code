import 'package:mobile/data/models/chat_message.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'default_model.dart';
import 'dto.dart';
import 'model_registry.dart';
import 'models.dart';

final class DeviceChatHomeOptions {
  const DeviceChatHomeOptions({
    required this.branchesSupported,
    required this.branches,
    required this.defaultBranch,
    required this.models,
    required this.defaultModelId,
    required this.defaultThinkingLevel,
    required this.providerAvailability,
  });
  final ProviderAvailability providerAvailability;
  final bool branchesSupported;
  final List<String> branches;
  final String? defaultBranch, defaultModelId, defaultThinkingLevel;
  final List<ModelOption> models;
}

/// Reads launcher choices through the existing computer transport. No read
/// creates a task or supplies authorization for a remembered destination.
final class DeviceChatHomeOptionsService {
  DeviceChatHomeOptionsService(this.ipc);
  final DesktopIpc ipc;

  Future<bool?> _runtimeAvailable(String channel) async {
    try {
      final status = deviceLinkObject(deviceChatDto(await ipc.invoke(channel)));
      return status['supported'] == true &&
          status['enabled'] == true &&
          status['installed'] == true;
    } catch (_) {
      // Optional on older hosts. The picker keeps unknown runtimes disabled.
      return null;
    }
  }

  Future<DeviceChatHomeOptions> load(String workspaceId) async {
    // Sequential reads leave headroom in the session's eight-RPC budget.
    Map<String, dynamic>? branchResult;
    try {
      branchResult = deviceLinkObject(
        deviceChatDto(
          await ipc.invoke('home:list-branch-targets', [
            {'workspaceId': workspaceId},
          ]),
        ),
      );
    } on DesktopIpcRefusal catch (cause) {
      if (cause.code != 'remote_channel_unavailable') rethrow;
    }
    final registry = deviceLinkObject(
      deviceChatDto(await ipc.invoke('model-registry:get')),
    );
    final catalog = deviceRegistryModels(registry);
    final defaults = await readDeviceDefaultModel(
      ipc,
      DeviceChatRef(projectId: workspaceId, worktreeId: '', id: '', title: ''),
      registry,
    );
    final cursor = await _runtimeAvailable('cursor-connection:status');
    final copilot = await _runtimeAvailable('copilot-connection:status');
    final supported = branchResult?['supported'] == true;
    final rows = (branchResult?['branches'] as List? ?? const [])
        .whereType<Map>();
    final defaultBranch = branchResult?['defaultBranch'] as String?;
    final remoteDefault = rows.any(
      (row) => row['name'] == defaultBranch && row['hasRemoteRef'] == true,
    );
    return DeviceChatHomeOptions(
      providerAvailability: ProviderAvailability(
        cursor: cursor,
        copilot: copilot,
      ),
      branchesSupported: supported,
      branches: {
        if (supported)
          for (final row in rows)
            if (row['name'] is String) ...[
              row['isRemote'] == true
                  ? 'origin/${row['name']}'
                  : row['name'] as String,
              if (row['isRemote'] != true && row['hasRemoteRef'] == true)
                'origin/${row['name']}',
            ],
      }.toList(),
      defaultBranch: remoteDefault ? 'origin/$defaultBranch' : defaultBranch,
      models: catalog,
      defaultModelId: defaults?.modelId,
      defaultThinkingLevel: defaults?.thinkingLevel,
    );
  }
}
