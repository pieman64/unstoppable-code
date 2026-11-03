import 'package:mobile/data/models/git_remote_url.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

/// Demo-mode clones for the mock remote control repository (CAN-3988).
/// Clones complete at once and add a project named after the repository.
final class MockRemoteProjectClones {
  MockRemoteProjectClones({
    required this._latency,
    required this._isConnected,
    required this._nextCommandId,
  });

  final Duration _latency;
  final bool Function() _isConnected;
  final String Function() _nextCommandId;
  final List<RemoteWorkspace> _workspaces = [];
  int _workspaceSeq = 0;

  /// Projects the demo clones added, in clone order.
  List<RemoteWorkspace> get workspaces => List.unmodifiable(_workspaces);

  late final commands = RemoteProjectCommands(
    submit: _submit,
    readStatus: (commandId) async => BrowserPortalCommandStatusResponse(
      commandId: commandId,
      status: BrowserPortalCommandStatus.completed,
    ),
  );

  Future<RemotePortalCommandResult> _submit({
    required String type,
    required Map<String, dynamic> payload,
  }) async {
    await Future<void>.delayed(_latency);
    if (!_isConnected()) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    final remoteUrl = payload['remoteUrl'];
    final workspace = RemoteWorkspace(
      localId: 'ws-mock-${++_workspaceSeq}',
      name: repositoryNameFromCloneUrl(remoteUrl is String ? remoteUrl : ''),
      type: RemoteWorkspaceType.singleRepo,
    );
    _workspaces.add(workspace);
    return RemotePortalCommandResult(
      commandId: _nextCommandId(),
      result: {'workspaceId': workspace.localId},
    );
  }
}
