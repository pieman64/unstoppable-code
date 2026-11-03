import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;

/// Shown when the paired desktop cannot read complete pipeline content.
const String kRemotePipelineContentUnsupported =
    'Update the desktop app to read complete step output and reports from '
    'your phone.';

typedef RemotePipelineContentRequest =
    Future<RemotePortalCommandResult> Function({
      required String type,
      required Map<String, dynamic> payload,
      Map<String, String>? target,
    });

/// Reads pipeline content through the repository's paired session transport.
final class RemotePipelineContentCommands {
  const RemotePipelineContentCommands({
    required this._hasCapability,
    required this._request,
  });

  final bool Function(String capability) _hasCapability;
  final RemotePipelineContentRequest _request;

  bool get isSupported => _hasCapability('pipeline_content');

  /// Reads one page inline, or returns a command id for a later event.
  /// Pass the first page's revision with every later page.
  Future<RemotePortalCommandResult> readPage({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineContentSource source,
    int offset = 0,
    String? revision,
  }) async {
    if (!isSupported) {
      throw const RemoteControlException(kRemotePipelineContentUnsupported);
    }
    final result = await _request(
      type: 'portal.pipeline.content.read',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'executionId': executionId,
        'source': source.toJson(),
        if (offset > 0) 'offset': offset,
        'revision': ?revision,
      },
    );
    if (result.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result;
  }
}
