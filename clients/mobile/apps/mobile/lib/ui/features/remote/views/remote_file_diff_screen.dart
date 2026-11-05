import 'package:mobile/ui/core/files/file_diff_view.dart';
export 'package:mobile/ui/core/files/file_diff_view.dart'
    show kRemoteFileDiffMaxLines, kRemoteFileDiffMaxCharactersPerLine;
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';
import 'package:mobile/ui/features/remote/view_models/unified_diff_lines.dart';
import 'package:provider/provider.dart';

/// Full-screen unified diff for one changed file in a worktree, read on
/// demand through `portal.diff.read` (web `DiffViewer` parity).
///
/// Cached results paint immediately and refresh in the background. Roster
/// revisions and line counts cannot identify same-size patch edits.
class RemoteFileDiffScreen extends StatefulWidget {
  const RemoteFileDiffScreen({
    super.key,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.file,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final RemoteChangedFile file;

  @override
  State<RemoteFileDiffScreen> createState() => _RemoteFileDiffScreenState();
}

class _RemoteFileDiffScreenState extends State<RemoteFileDiffScreen> {
  RemoteFileDiff? _diff;
  List<UnifiedDiffLine> _lines = const [];
  bool _truncated = false;
  bool _lineLengthTruncated = false;
  String? _error;
  bool _loading = true;
  String? _cacheNotice;
  int _requestSeq = 0;
  late int _openedGeneration;
  late RemoteFileDiffCacheKey _openedKey;

  // A committed-only file has no working-tree change, so its diff must come
  // from the branch range (web parity).
  RemoteDiffSource get _source => widget.file.committed
      ? RemoteDiffSource.committed
      : RemoteDiffSource.uncommitted;

  RemoteFileDiffCacheKey get _cacheKey => RemoteFileDiffCacheKey(
    workspaceLocalId: widget.workspaceLocalId,
    worktreeLocalId: widget.worktreeLocalId,
    repoId: widget.file.repoId,
    path: widget.file.filePath,
    source: _source,
    status: widget.file.status,
    revision: widget.file.revision,
    insertions: widget.file.insertions,
    deletions: widget.file.deletions,
  );

  @override
  void initState() {
    super.initState();
    _openedGeneration = context
        .read<RemoteControlViewModel>()
        .sessionGeneration;
    _open();
  }

  @override
  void didUpdateWidget(RemoteFileDiffScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_cacheKey != _openedKey) _open();
  }

  void _open() {
    final seq = ++_requestSeq;
    _openedKey = _cacheKey;
    _diff = null;
    _lines = const [];
    _error = null;
    _cacheNotice = null;
    final cached = context.read<RemoteControlViewModel>().fileDiffCache.get(
      _cacheKey,
    );
    if (cached != null) {
      _apply(cached);
      _loading = false;
      _cacheNotice = 'Cached diff. Checking for changes…';
      unawaited(_load(showLoading: false, preserveCachedOnError: true));
    } else {
      _loading = true;
      unawaited(_loadAfterRestore(seq));
    }
  }

  Future<void> _loadAfterRestore(int seq) async {
    final vm = context.read<RemoteControlViewModel>();
    final cached = await vm.fileDiffCache.getAfterRestore(_openedKey);
    if (_discardIfSessionChanged(
      viewModel: vm,
      sessionGeneration: _openedGeneration,
      seq: seq,
    )) {
      return;
    }
    if (cached != null) {
      setState(() {
        _apply(cached);
        _loading = false;
        _cacheNotice = 'Cached diff. Checking for changes…';
      });
    }
    await _load(
      showLoading: cached == null,
      preserveCachedOnError: cached != null,
    );
  }

  void _apply(RemoteFileDiff diff) {
    final classification = classifyUnifiedDiffLinesBounded(
      diff.patch,
      maxLines: kRemoteFileDiffMaxLines,
    );
    final lines = stripUnifiedDiffFileHeaders(classification.lines);
    final lineLengthTruncated = lines.any(
      (line) => line.text.length > kRemoteFileDiffMaxCharactersPerLine,
    );
    final boundedLines = [
      for (final line in lines)
        if (line.text.length > kRemoteFileDiffMaxCharactersPerLine)
          UnifiedDiffLine(
            line.kind,
            '${line.text.substring(0, kRemoteFileDiffMaxCharactersPerLine - 1)}…',
          )
        else
          line,
    ];
    _diff = diff;
    _truncated = classification.isTruncated;
    _lineLengthTruncated = lineLengthTruncated;
    _lines = boundedLines;
  }

  bool _discardIfSessionChanged({
    required RemoteControlViewModel viewModel,
    required int sessionGeneration,
    required int seq,
  }) {
    if (!mounted || seq != _requestSeq) return true;
    if (sessionGeneration == viewModel.sessionGeneration) return false;
    setState(() {
      _diff = null;
      _lines = const [];
      _truncated = false;
      _lineLengthTruncated = false;
      _error = 'The remote session ended. Go back and reconnect.';
      _loading = false;
    });
    return true;
  }

  Future<void> _load({
    bool showLoading = true,
    bool preserveCachedOnError = false,
  }) async {
    final seq = ++_requestSeq;
    final cacheKey = _cacheKey;
    if (showLoading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    final viewModel = context.read<RemoteControlViewModel>();
    final sessionGeneration = viewModel.sessionGeneration;
    final readId = viewModel.fileDiffCache.beginRead(cacheKey);
    try {
      final diff = await viewModel.repository.readFileDiff(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        path: widget.file.filePath,
        repoId: widget.file.repoId,
        source: _source,
      );
      if (_discardIfSessionChanged(
        viewModel: viewModel,
        sessionGeneration: sessionGeneration,
        seq: seq,
      )) {
        return;
      }
      viewModel.fileDiffCache.put(cacheKey, diff, readId: readId);
      _cacheNotice = null;
      setState(() {
        _apply(diff);
        _loading = false;
      });
    } on RemoteControlException catch (e) {
      if (_discardIfSessionChanged(
        viewModel: viewModel,
        sessionGeneration: sessionGeneration,
        seq: seq,
      )) {
        return;
      }
      if ((preserveCachedOnError || _cacheNotice != null) && _diff != null) {
        setState(
          () =>
              _cacheNotice = 'Cached diff. Could not refresh. Reopen to retry.',
        );
        return;
      }
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (_) {
      if (_discardIfSessionChanged(
        viewModel: viewModel,
        sessionGeneration: sessionGeneration,
        seq: seq,
      )) {
        return;
      }
      if ((preserveCachedOnError || _cacheNotice != null) && _diff != null) {
        setState(
          () =>
              _cacheNotice = 'Cached diff. Could not refresh. Reopen to retry.',
        );
        return;
      }
      setState(() {
        _error = 'Could not load the diff.';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final sessionGeneration = context.select<RemoteControlViewModel, int>(
      (vm) => vm.sessionGeneration,
    );
    final theme = Theme.of(context);
    final fileName = widget.file.filePath.split('/').last;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          fileName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.titleMedium,
        ),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context);
          if (sessionGeneration != _openedGeneration) {
            return FileDiffNotice(
              padding: padding,
              message: 'The remote session ended. Go back and reconnect.',
            );
          }
          final error = _error;
          if (_loading) {
            return Padding(
              padding: padding,
              child: const Center(child: CircularProgressIndicator()),
            );
          }
          if (error != null) {
            return FileDiffNotice(
              padding: padding,
              message: error,
              action: FilledButton.tonal(
                key: const ValueKey('file-diff-retry'),
                onPressed: () => unawaited(_load()),
                child: const Text('Retry'),
              ),
            );
          }
          return FileDiffView(
            padding: padding,
            file: widget.file,
            diff: _diff,
            lines: _lines,
            truncated: _truncated,
            lineLengthTruncated: _lineLengthTruncated,
            cacheNotice: _cacheNotice,
          );
        },
      ),
    );
  }
}
