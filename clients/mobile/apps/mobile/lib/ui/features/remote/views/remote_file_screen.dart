import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_file_client.dart'
    show remoteImageMaxBytes;
import 'package:mobile/ui/core/file_viewer/file_viewer_screen.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_viewer_source.dart';
import 'package:provider/provider.dart';

/// [FileViewerScreen] for one worktree file read through Remote control
/// (CAN-5130).
///
/// Reads go through the paired session that was current when the screen
/// opened. When that session changes, the viewer drops everything it read.
class RemoteFileScreen extends StatefulWidget {
  const RemoteFileScreen({
    super.key,
    required this.request,
    this.imageCacheBytes = remoteImageMaxBytes,
  });

  final RemoteFileRequest request;

  /// The view model's image byte budget. Tests lower it to force eviction.
  @visibleForTesting
  final int imageCacheBytes;

  @override
  State<RemoteFileScreen> createState() => _RemoteFileScreenState();
}

class _RemoteFileScreenState extends State<RemoteFileScreen> {
  late final RemoteControlViewModel _remote;
  late final int _sessionGeneration;
  late final FileViewerViewModel _file;

  bool get _desktopOnline =>
      _remote.isConnected &&
      _remote.portalConnectionStatus != RemotePortalConnectionStatus.inactive;

  @override
  void initState() {
    super.initState();
    _remote = context.read<RemoteControlViewModel>();
    _sessionGeneration = _remote.sessionGeneration;
    _file = FileViewerViewModel(
      source: RemoteFileViewerSource(
        repository: _remote.repository,
        request: widget.request,
      ),
      path: widget.request.relativePath,
      online: _desktopOnline,
      imageCacheBytes: widget.imageCacheBytes,
    );
    _remote.addListener(_onRemoteChanged);
    unawaited(_file.load());
  }

  @override
  void dispose() {
    _remote.removeListener(_onRemoteChanged);
    _file.dispose();
    super.dispose();
  }

  void _onRemoteChanged() {
    if (_remote.sessionGeneration == _sessionGeneration) {
      _file.setOnline(_desktopOnline);
    } else {
      _file.endSession();
    }
  }

  @override
  Widget build(BuildContext context) => FileViewerScreen(file: _file);
}
