import '../chats/models.dart';
import 'package:mobile/data/models/workspace_context.dart';

final class DeviceProject {
  DeviceProject({
    required this.id,
    required this.name,
    required this.type,
    this.color,
    this.temporary = false,
    this.alwaysShow = true,
    this.ownerContext,
  });
  final String id, name, type;
  final String? color;
  final bool temporary, alwaysShow;

  /// From the desktop session's workspace projection. Null means ownership
  /// could not be established, including when the snapshot is unavailable.
  final WorkspaceContext? ownerContext;
}

final class DeviceWorktree {
  DeviceWorktree({
    required this.projectId,
    required this.projectName,
    required this.id,
    required this.name,
    required this.savedStatus,
    this.projection,
    this.pipelineStatus,
  });
  final String projectId, projectName, id, name;
  final String? savedStatus;

  /// This worktree's `desktop:session-snapshot` row. Absent on hosts that
  /// cannot project it.
  final Map<String, dynamic>? projection;

  /// Sidebar pipeline status wire value from `devicePipelineStatuses`.
  final String? pipelineStatus;
  List<DeviceChatRef> chats = [];
  String status = 'Loading';
  String? activeChatId;
  bool unread = false, pendingQuestion = false, pendingApproval = false;
  bool isStreaming = false;
  final workingChats = <String>{};
  Map<String, dynamic> get scope => {'projectId': projectId, 'worktreeId': id};
  String get key => '$projectId/$id';
}
