import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_file_client.dart'
    show remoteImageMaxBytes;
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_image_screen.dart';
import 'package:provider/provider.dart';

/// Full-screen, read-only view of one worktree file (CAN-5130), modelled on
/// [RemoteFileDiffScreen]. Markdown opens formatted, with images read from
/// the same root; other text opens as source.
///
/// Reads go through the paired session that was current when the screen
/// opened. When that session changes, the screen drops everything it read
/// and closes an open image. Closing the screen or ending the session also
/// releases the decoded images it shows from Flutter's image cache.
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
  late final RemoteFileViewModel _file;
  Route<void>? _imageRoute;

  /// Every image buffer this screen showed. `Image.memory` caches each one
  /// globally under `MemoryImage(bytes)`, outside the view model's budget
  /// and even after the view model evicts it. Weak references find those
  /// entries without keeping the buffers alive.
  final _shownImages = <WeakReference<Uint8List>>[];

  bool get _desktopOnline =>
      _remote.isConnected &&
      _remote.portalConnectionStatus != RemotePortalConnectionStatus.inactive;

  @override
  void initState() {
    super.initState();
    _remote = context.read<RemoteControlViewModel>();
    _sessionGeneration = _remote.sessionGeneration;
    _file = RemoteFileViewModel(
      repository: _remote.repository,
      request: widget.request,
      desktopOnline: _desktopOnline,
      imageCacheBytes: widget.imageCacheBytes,
    );
    _remote.addListener(_onRemoteChanged);
    unawaited(_file.load());
  }

  @override
  void dispose() {
    _remote.removeListener(_onRemoteChanged);
    _file.dispose();
    _releaseImages();
    super.dispose();
  }

  void _onRemoteChanged() {
    if (_remote.sessionGeneration == _sessionGeneration) {
      _file.setDesktopOnline(_desktopOnline);
      return;
    }
    _file.endSession();
    if (_imageRoute case final route? when route.isActive) {
      Navigator.of(context).removeRoute(route);
    }
    _imageRoute = null;
    _releaseImages();
  }

  Future<Uint8List> _readImage(String source) =>
      _file.readImage(source).then(_trackImage);

  Uint8List _trackImage(Uint8List bytes) {
    _shownImages.removeWhere((shown) => shown.target == null);
    if (!_shownImages.any((shown) => identical(shown.target, bytes))) {
      _shownImages.add(WeakReference(bytes));
    }
    return bytes;
  }

  /// Evicts only this screen's keys; other cached images stay.
  void _releaseImages() {
    for (final shown in _shownImages) {
      if (shown.target case final bytes?) {
        imageCache.evict(MemoryImage(bytes));
      }
    }
    _shownImages.clear();
  }

  void _openImage(String source, Uint8List bytes) {
    // One image at a time, so a session change can close every one.
    if (_imageRoute?.isActive ?? false) return;
    _trackImage(bytes);
    final name = source.split(RegExp('[?#]')).first.split('/').last;
    final route = MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) =>
          RemoteImageScreen(bytes: bytes, label: name.isEmpty ? 'Image' : name),
    );
    _imageRoute = route;
    unawaited(Navigator.of(context).push(route));
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return ListenableBuilder(
      listenable: _file,
      builder: (context, _) {
        final folders = _file.folders;
        return CanopyScaffold(
          appBar: CanopyAppBar(
            automaticallyImplyLeading: true,
            content: Text(_file.fileName),
            subtitle: folders.isEmpty
                ? null
                : Text(
                    folders.join(' / '),
                    key: const ValueKey('remote-file-breadcrumb'),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.foregroundSecondary,
                      fontFamily: AppTypography.monoFamily,
                    ),
                  ),
          ),
          body: Builder(
            builder: (context) {
              final padding = CanopyScaffold.contentPaddingOf(context);
              final contents = _file.contents;
              if (_file.problem case final problem?) {
                return _ProblemBody(
                  padding: padding,
                  problem: problem,
                  retrying: _file.loading,
                  onRetry: () => unawaited(_file.load()),
                );
              }
              if (contents == null) return _LoadingBody(padding: padding);
              return _ContentBody(
                padding: padding,
                file: _file,
                contents: contents,
                imageResolver: _readImage,
                onImageTap: _openImage,
              );
            },
          ),
        );
      },
    );
  }
}

String _problemMessage(RemoteFileProblem problem) => switch (problem) {
  RemoteFileProblem.invalidPath =>
    "Couldn't open this file. Its path is outside this workspace.",
  RemoteFileProblem.notFound =>
    "Couldn't find this file. It may have been moved or deleted.",
  RemoteFileProblem.unsupported => "This file can't be shown as text.",
  RemoteFileProblem.permissionDenied =>
    "You don't have permission to open this file.",
  RemoteFileProblem.offline =>
    'Your desktop is offline. This file opens when it reconnects.',
  RemoteFileProblem.timedOut => 'Opening this file took too long. Try again.',
  RemoteFileProblem.unavailable => "Couldn't open this file. Try again.",
  RemoteFileProblem.sessionEnded =>
    'The remote session ended. Go back and reconnect.',
};

class _ProblemBody extends StatelessWidget {
  const _ProblemBody({
    required this.padding,
    required this.problem,
    required this.retrying,
    required this.onRetry,
  });

  final EdgeInsets padding;
  final RemoteFileProblem problem;
  final bool retrying;
  final VoidCallback onRetry;

  bool get _canRetry =>
      problem == RemoteFileProblem.timedOut ||
      problem == RemoteFileProblem.unavailable;

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
              _problemMessage(problem),
              key: const ValueKey('remote-file-problem'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: AppColors.of(context).foregroundSecondary,
              ),
            ),
            if (_canRetry) ...[
              const SizedBox(height: 16),
              CanopyButton(
                key: const ValueKey('remote-file-retry'),
                label: retrying ? 'Trying again…' : 'Try again',
                loading: retrying,
                variant: CanopyButtonVariant.inline,
                onPressed: retrying ? null : onRetry,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ContentBody extends StatelessWidget {
  const _ContentBody({
    required this.padding,
    required this.file,
    required this.contents,
    required this.imageResolver,
    required this.onImageTap,
  });

  final EdgeInsets padding;
  final RemoteFileViewModel file;
  final RemoteFileContents contents;
  final MessageImageResolver imageResolver;
  final MessageImageTap onImageTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final text = contents.contents;
    final lines = text.isEmpty ? const <String>[] : text.split('\n');
    final lineStyle = AppTypography.code.copyWith(color: colors.foreground);
    // Source lines stay lazy so a 256 KiB file does not lay out at once.
    final source = _list(
      RemoteFileMode.source,
      itemCount: lines.length,
      itemBuilder: (index) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Text(lines[index], style: lineStyle),
      ),
    );
    if (!file.isMarkdown) return source;
    final formatted = _list(
      RemoteFileMode.formatted,
      itemCount: text.isEmpty ? 0 : 1,
      itemBuilder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        child: MessageMarkdown(
          key: const ValueKey('remote-file-formatted'),
          text: text,
          selectable: true,
          style: theme.textTheme.bodyMedium?.copyWith(color: colors.foreground),
          // The desktop cannot serve images: alt text only, no reads.
          imageResolver: file.imagesUnavailable ? null : imageResolver,
          onImageTap: onImageTap,
        ),
      ),
    );
    // Both modes stay mounted, so switching back neither reloads images
    // nor loses either scroll position.
    return IndexedStack(
      index: file.mode == RemoteFileMode.formatted ? 0 : 1,
      children: [formatted, source],
    );
  }

  Widget _list(
    RemoteFileMode mode, {
    required int itemCount,
    required Widget Function(int index) itemBuilder,
  }) => SelectionArea(
    child: ListView.builder(
      padding: padding,
      itemCount: 1 + itemCount,
      itemBuilder: (context, index) =>
          index == 0 ? _header(context, mode) : itemBuilder(index - 1),
    ),
  );

  Widget _header(BuildContext context, RemoteFileMode mode) {
    final noteStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
      color: AppColors.of(context).foregroundSecondary,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (file.isMarkdown)
            SegmentedButton<RemoteFileMode>(
              key: const ValueKey('remote-file-mode'),
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(
                  value: RemoteFileMode.formatted,
                  label: Text('Formatted'),
                ),
                ButtonSegment(
                  value: RemoteFileMode.source,
                  label: Text('Source'),
                ),
              ],
              selected: {mode},
              onSelectionChanged: (selection) =>
                  file.showMode(selection.single),
            ),
          if (contents.truncated)
            _Note(
              key: const ValueKey('remote-file-truncated'),
              text:
                  'Showing the first 256 KiB. Open the file on your desktop '
                  'to see the rest.',
              style: noteStyle,
            ),
          if (mode == RemoteFileMode.formatted && file.imagesUnavailable)
            _Note(
              key: const ValueKey('remote-file-images-unavailable'),
              text: 'Update your desktop app to show images.',
              style: noteStyle,
            ),
          if (contents.contents.isEmpty)
            _Note(
              key: const ValueKey('remote-file-empty'),
              text: 'This file is empty.',
              style: noteStyle,
            ),
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({super.key, required this.text, this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(text, style: style),
  );
}

/// Reserves the body, then shows text-shaped skeleton lines after 200ms.
/// The lines hold still under reduced motion.
class _LoadingBody extends StatefulWidget {
  const _LoadingBody({required this.padding});

  final EdgeInsets padding;

  @override
  State<_LoadingBody> createState() => _LoadingBodyState();
}

class _LoadingBodyState extends State<_LoadingBody>
    with TickerProviderStateMixin {
  late final AnimationController _delay = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 200),
  )..forward();
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 800),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _pulse.stop();
      _pulse.value = 1;
    } else {
      _pulse.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _delay.dispose();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.surfaceContainerHighest;
    return AnimatedBuilder(
      animation: _delay,
      builder: (context, _) {
        if (!_delay.isCompleted) return const SizedBox.expand();
        return Semantics(
          key: const ValueKey('remote-file-loading'),
          label: 'Loading file',
          child: FadeTransition(
            opacity: _pulse.drive(Tween(begin: 0.5, end: 1.0)),
            child: ListView(
              physics: const NeverScrollableScrollPhysics(),
              padding: widget.padding.add(
                const EdgeInsets.fromLTRB(16, 16, 16, 0),
              ),
              children: [
                for (final widthFactor in [0.6, 0.9, 0.8, 0.95, 0.5, 0.85])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: FractionallySizedBox(
                      alignment: Alignment.centerLeft,
                      widthFactor: widthFactor,
                      child: DecoratedBox(
                        decoration: ShapeDecoration(
                          color: fill,
                          shape: const StadiumBorder(),
                        ),
                        child: const SizedBox(height: 14),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
