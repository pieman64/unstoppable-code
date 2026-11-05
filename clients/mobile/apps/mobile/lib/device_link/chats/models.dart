import 'package:mobile/data/models/chat_tab_item.dart';
import '../protocol.dart';
import '../crypto/identity.dart';
import '../worktree_ref.dart';

String chatId() {
  // UUID v4 IDs are accepted by existing desktop validators and receipts.
  final bytes = linkRandomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((n) => n.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

final class DeviceChatRef implements ChatTabItem, DeviceWorktreeRef {
  const DeviceChatRef({
    required this.projectId,
    required this.worktreeId,
    required this.id,
    required this.title,
  });
  factory DeviceChatRef.fromCatalog(Map<String, dynamic> json) => DeviceChatRef(
    projectId: deviceLinkString(json, 'projectId'),
    worktreeId: deviceLinkString(json, 'worktreeId'),
    id: deviceLinkString(json, 'chatId'),
    title: json['title'] is String && (json['title'] as String).isNotEmpty
        ? json['title'] as String
        : 'Chat',
  );
  @override
  final String projectId;
  @override
  final String worktreeId;
  final String id, title;
  @override
  String get chatId => id;
  @override
  String get displayTitle => title;
  String get key => '$projectId/$worktreeId/$id';
  Map<String, dynamic> get scope => {
    'projectId': projectId,
    'worktreeId': worktreeId,
  };
  Map<String, dynamic> get target => {...scope, 'chatId': id};
  bool matchesScope(Map<String, dynamic> value) =>
      value['projectId'] == projectId && value['worktreeId'] == worktreeId;
}

final class DeviceChatWorkspace {
  DeviceChatWorkspace(this.id, this.name);
  final String id, name;
}

final class DeviceChatMessage {
  DeviceChatMessage(this.raw);
  final Map<String, dynamic> raw;
  String get id => deviceLinkString(raw, 'id');
  String get role => raw['role'] is String ? raw['role'] as String : 'system';
  bool get hidden =>
      raw['hidden'] == true ||
      raw['parentBlockId'] is String ||
      raw['parentToolUseId'] is String;
  List<Map<String, dynamic>> get blocks => raw['blocks'] is List
      ? (raw['blocks'] as List).whereType<Map<String, dynamic>>().toList()
      : const [];
  String get text => blocks
      .where((block) => block['type'] == 'text')
      .map((block) => block['text'] is String ? block['text'] as String : '')
      .where((text) => text.isNotEmpty)
      .join('\n\n');
  List<String> get activities => blocks
      .where((b) => b['type'] != 'text')
      .map(
        (b) => switch (b['type']) {
          'thinking' => 'Thinking',
          'tool_use' => (b['name'] as String?) ?? 'Tool activity',
          'codex_agent_call' => 'Agent activity',
          _ => 'Agent activity',
        },
      )
      .toSet()
      .toList();
}
