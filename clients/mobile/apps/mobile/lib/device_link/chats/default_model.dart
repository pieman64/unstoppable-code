import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';

/// Reads saved model and thinking defaults without creating a tab override.
/// A projected catalog default takes precedence at the caller. Routing and
/// admission on send still belong to the computer.
Future<({String modelId, String? thinkingLevel})?> readDeviceDefaultModel(
  DesktopIpc ipc,
  DeviceChatRef ref,
  Map<String, dynamic> registry,
) async {
  try {
    if (ref.projectId == 'app-advisor') {
      final preferences = deviceLinkObject(
        deviceChatDto(await ipc.invoke('preferences:load')),
      );
      final model = preferences['appAdvisorModel'];
      if (model is! String || model.isEmpty) return null;
      final aliases = registry['aliases'];
      final canonical = aliases is Map ? aliases[model] : null;
      return (
        modelId: canonical is String ? canonical : model,
        thinkingLevel: preferences['appAdvisorThinkingLevel'] as String?,
      );
    }
    final values = await Future.wait<Object?>([
      ipc.invoke('preferences:load'),
      ipc.invoke('projects:load'),
    ]);
    final preferences = deviceLinkObject(deviceChatDto(values[0]));
    final projects = deviceLinkObject(deviceChatDto(values[1]));
    final project = (projects['items'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .where((row) => row['id'] == ref.projectId)
        .firstOrNull;
    final scope = switch (project?['type']) {
      'cowork' => 'Chat',
      'single-repo' || 'multi-repo' => 'Worktree',
      _ => null,
    };
    if (scope == null) return null;
    final provider = preferences['default${scope}Provider'];
    final defaults = preferences['default${scope}ModelByProvider'];
    final selection = defaults is Map ? defaults[provider] : null;
    final model = selection is Map ? selection['model'] : null;
    if (model is! String || model.isEmpty) return null;
    final aliases = registry['aliases'];
    final canonical = aliases is Map ? aliases[model] : null;
    return (
      modelId: canonical is String && canonical.isNotEmpty ? canonical : model,
      thinkingLevel: selection is Map && selection['thinkingLevel'] is String
          ? selection['thinkingLevel'] as String
          : null,
    );
  } catch (_) {
    // Older or restricted hosts may not expose these optional reads. Keep
    // explicit models and the picker usable, without guessing a default.
    return null;
  }
}
