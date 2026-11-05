import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/files/changed_files_tab.dart' as shared;
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../remote_file_diff_screen.dart';
export 'package:mobile/ui/core/files/changed_files_tab.dart'
    show kChangedFilesLoadingLabel, kChangedFilesRefreshingLabel;

class ChangedFilesTab extends StatelessWidget {
  const ChangedFilesTab({
    super.key,
    required this.worktree,
    required this.files,
    required this.status,
    this.onRetry,
  });
  final RemoteWorktree worktree;
  final List<RemoteChangedFile> files;
  final ChangedFilesLoadStatus status;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => shared.ChangedFilesTab(
    files: files,
    status: status,
    onRetry: onRetry,
    onOpenDiff: (file) {
      final viewModel = context.read<RemoteControlViewModel>();
      unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                ChangeNotifierProvider<RemoteControlViewModel>.value(
                  value: viewModel,
                  child: RemoteFileDiffScreen(
                    workspaceLocalId: worktree.workspaceLocalId,
                    worktreeLocalId: worktree.localId,
                    file: file,
                  ),
                ),
          ),
        ),
      );
    },
  );
}
