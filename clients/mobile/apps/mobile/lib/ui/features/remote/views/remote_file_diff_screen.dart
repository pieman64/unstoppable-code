import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';
import 'package:mobile/ui/features/remote/view_models/unified_diff_lines.dart';
import 'package:provider/provider.dart';

/// Upper bound on rendered patch lines. The desktop reads a diff with a
/// 16 MB git buffer and no pagination, so one generated file can arrive as
/// a very long string; past this the screen shows a notice instead of
/// inflating a list nobody scrolls to the end of.
const int kRemoteFileDiffMaxLines = 5000;

/// Upper bound on the displayed length of one patch line. This keeps a
/// minified or generated line from creating an enormous horizontal layout.
const int kRemoteFileDiffMaxCharactersPerLine = 1000;

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
            return _Notice(
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
            return _Notice(
              padding: padding,
              message: error,
              action: FilledButton.tonal(
                key: const ValueKey('file-diff-retry'),
                onPressed: () => unawaited(_load()),
                child: const Text('Retry'),
              ),
            );
          }
          return _DiffBody(
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

class _Notice extends StatelessWidget {
  const _Notice({required this.padding, required this.message, this.action});

  final EdgeInsets padding;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (action case final action?) ...[
              const SizedBox(height: 12),
              action,
            ],
          ],
        ),
      ),
    );
  }
}

class _DiffBody extends StatelessWidget {
  const _DiffBody({
    required this.padding,
    required this.file,
    required this.diff,
    required this.lines,
    required this.truncated,
    required this.lineLengthTruncated,
    this.cacheNotice,
  });

  final EdgeInsets padding;
  final RemoteChangedFile file;
  final RemoteFileDiff? diff;
  final List<UnifiedDiffLine> lines;
  final bool truncated;
  final bool lineLengthTruncated;
  final String? cacheNotice;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final header = _DiffHeader(
      file: file,
      diff: diff,
      truncated: truncated,
      lineLengthTruncated: lineLengthTruncated,
      cacheNotice: cacheNotice,
    );
    if (lines.isEmpty) {
      return ListView(
        padding: padding,
        children: [
          header,
          const SizedBox(height: 48),
          Center(
            child: Text(
              'No changes to show.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      );
    }
    // The vertical list stays lazy; the horizontal axis is one scroll view
    // sized from the longest line so long code never wraps into unreadable
    // fragments. Monospace glyphs are ~0.6em wide.
    final lineStyle = AppTypography.code;
    final charWidth = (lineStyle.fontSize ?? 13) * 0.62;
    final longest = lines.fold<int>(0, (m, line) => max(m, line.text.length));
    final contentWidth = longest * charWidth + 32;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = max(contentWidth, constraints.maxWidth);
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: width,
            child: ListView.builder(
              padding: padding,
              itemCount: lines.length + 1,
              itemBuilder: (context, index) {
                if (index == 0) {
                  // The list is as wide as the longest line; the header
                  // must wrap at the viewport instead, so loosen the
                  // cross-axis constraint before sizing it.
                  return Align(
                    alignment: Alignment.topLeft,
                    child: SizedBox(width: constraints.maxWidth, child: header),
                  );
                }
                final line = lines[index - 1];
                final (
                  Color? background,
                  Color foreground,
                ) = switch (line.kind) {
                  UnifiedDiffLineKind.add => (
                    status.success.withValues(alpha: 0.12),
                    status.success,
                  ),
                  UnifiedDiffLineKind.del => (
                    status.destructive.withValues(alpha: 0.12),
                    status.destructive,
                  ),
                  UnifiedDiffLineKind.hunk => (
                    status.unread.withValues(alpha: 0.12),
                    status.unread,
                  ),
                  UnifiedDiffLineKind.meta => (
                    null,
                    theme.colorScheme.onSurfaceVariant,
                  ),
                  UnifiedDiffLineKind.context => (
                    null,
                    theme.colorScheme.onSurface,
                  ),
                };
                return Container(
                  color: background,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    line.text,
                    softWrap: false,
                    overflow: TextOverflow.visible,
                    style: lineStyle.copyWith(color: foreground),
                  ),
                );
              },
            ),
          ),
        );
      },
    );
  }
}

class _DiffHeader extends StatelessWidget {
  const _DiffHeader({
    required this.file,
    required this.diff,
    this.truncated = false,
    this.lineLengthTruncated = false,
    this.cacheNotice,
  });

  final RemoteChangedFile file;
  final RemoteFileDiff? diff;

  /// Shown up front (not at the end of a lazy list nobody reaches) when the
  /// patch was clipped to [kRemoteFileDiffMaxLines].
  final bool truncated;
  final bool lineLengthTruncated;
  final String? cacheNotice;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final insertions = diff?.insertions ?? file.insertions ?? 0;
    final deletions = diff?.deletions ?? file.deletions ?? 0;
    final rangeLabel = diff?.rangeLabel;
    final details = [
      if (file.repoName case final repoName? when repoName.isNotEmpty) repoName,
      file.committed ? 'committed' : 'uncommitted',
      ?rangeLabel,
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (cacheNotice case final notice?)
            Text(
              notice,
              key: const ValueKey('file-diff-cache-notice'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          Text(
            file.filePath,
            style: theme.textTheme.bodySmall?.copyWith(
              fontFamily: AppTypography.monoFamily,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  details,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              if (insertions > 0)
                Text(
                  '+$insertions',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: status.success,
                  ),
                ),
              if (insertions > 0 && deletions > 0) const SizedBox(width: 8),
              if (deletions > 0)
                Text(
                  '-$deletions',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: status.destructive,
                  ),
                ),
            ],
          ),
          if (truncated) ...[
            const SizedBox(height: 6),
            Text(
              'Showing the first $kRemoteFileDiffMaxLines lines.',
              style: theme.textTheme.labelSmall?.copyWith(
                color: status.warning,
              ),
            ),
          ],
          if (lineLengthTruncated) ...[
            const SizedBox(height: 6),
            Text(
              'Some lines were shortened to '
              '$kRemoteFileDiffMaxCharactersPerLine characters.',
              style: theme.textTheme.labelSmall?.copyWith(
                color: status.warning,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
