import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/changed_file.dart';
import 'package:mobile/device_link/files/repository.dart';
import 'package:mobile/device_link/worktree_ref.dart';
import 'package:mobile/ui/core/files/file_diff_view.dart';
import 'package:mobile/ui/core/files/unified_diff_lines.dart';

class DeviceFileDiffScreen extends StatefulWidget {
  const DeviceFileDiffScreen({
    super.key,
    required this.repository,
    required this.ref,
    required this.file,
  });
  final DeviceFileDiffRepository repository;
  final DeviceWorktreeRef ref;
  final RemoteChangedFile file;
  @override
  State<DeviceFileDiffScreen> createState() => _DeviceFileDiffScreenState();
}

class _DeviceFileDiffScreenState extends State<DeviceFileDiffScreen> {
  late StreamSubscription<DeviceFileDiffKey> _subscription;
  late void Function() _release;
  @override
  void initState() {
    super.initState();
    _bind();
  }

  @override
  void didUpdateWidget(DeviceFileDiffScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository != widget.repository ||
        oldWidget.ref.projectId != widget.ref.projectId ||
        oldWidget.ref.worktreeId != widget.ref.worktreeId ||
        oldWidget.file != widget.file) {
      unawaited(_subscription.cancel());
      _release();
      _bind();
    }
  }

  void _bind() {
    final key = widget.repository.key(widget.ref, widget.file);
    _subscription = widget.repository.updates.listen((updated) {
      if (mounted && key == updated) setState(() {});
    });
    _release = widget.repository.watch(widget.ref, widget.file);
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    _release();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: Text(
        widget.file.filePath.split('/').last,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.titleMedium,
      ),
    ),
    body: Builder(
      builder: (context) {
        final padding = CanopyScaffold.contentPaddingOf(context);
        final state = widget.repository.state(widget.ref, widget.file);
        final diff = state.diff;
        if (diff == null && state.refreshing) {
          return Padding(
            padding: padding,
            child: const Center(child: CircularProgressIndicator()),
          );
        }
        if (diff == null && state.error != null) {
          return FileDiffNotice(
            padding: padding,
            message: state.error!,
            action: FilledButton.tonal(
              key: const ValueKey('file-diff-retry'),
              onPressed: () =>
                  unawaited(widget.repository.refresh(widget.ref, widget.file)),
              child: const Text('Try again'),
            ),
          );
        }
        final parsed = classifyUnifiedDiffLinesBounded(
          diff?.patch ?? '',
          maxLines: kRemoteFileDiffMaxLines,
        );
        final lines = stripUnifiedDiffFileHeaders(parsed.lines);
        final clipped = lines.any(
          (l) => l.text.length > kRemoteFileDiffMaxCharactersPerLine,
        );
        final notices = [
          if (state.stale && diff != null)
            'Showing the previously loaded diff.',
          ?state.error,
          if (state.truncated)
            'The computer returned a partial diff. Open it on your computer to see all changes.',
          // The list counted lines, but the file now matches: its changes
          // were committed or discarded after the list loaded.
          if (!state.stale &&
              diff != null &&
              diff.patch.isEmpty &&
              (widget.file.insertions ?? 0) + (widget.file.deletions ?? 0) > 0)
            widget.file.committed
                ? 'These changes are no longer on this branch.'
                : 'These changes were committed or discarded on your computer.',
        ];
        return FileDiffView(
          padding: padding,
          file: widget.file,
          diff: diff,
          lines: [
            for (final l in lines)
              UnifiedDiffLine(
                l.kind,
                l.text.length > kRemoteFileDiffMaxCharactersPerLine
                    ? '${l.text.substring(0, kRemoteFileDiffMaxCharactersPerLine - 1)}…'
                    : l.text,
              ),
          ],
          truncated: parsed.isTruncated,
          cacheNotice: notices.isEmpty ? null : notices.join(' '),
          lineLengthTruncated: clipped,
        );
      },
    ),
  );
}
