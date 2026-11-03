import 'dart:typed_data';

import 'package:flutter/material.dart';

/// The caller owns source policy and I/O. The Markdown renderer only uses bytes.
typedef MessageImageResolver = Future<Uint8List> Function(String source);

/// Loaded bytes are supplied so opening a viewer does not require a second read.
typedef MessageImageTap = void Function(String source, Uint8List bytes);

/// Safe, short reasons that callers can return without exposing transport errors.
enum MessageImageFailure implements Exception {
  notFound('Image not found'),
  unsupported('Unsupported image'),
  unavailable("Couldn't load image");

  const MessageImageFailure(this.label);
  final String label;
}

/// Resolves once per source/resolver pair, including across parent rebuilds.
class MessageMarkdownImage extends StatefulWidget {
  const MessageMarkdownImage({
    super.key,
    required this.source,
    required this.alt,
    required this.resolver,
    this.onTap,
    this.style,
  });

  final String source;
  final String alt;
  final MessageImageResolver resolver;
  final MessageImageTap? onTap;
  final TextStyle? style;

  @override
  State<MessageMarkdownImage> createState() => _MessageMarkdownImageState();
}

class _MessageMarkdownImageState extends State<MessageMarkdownImage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _loadingDelay;
  late Future<Uint8List> _bytes;

  @override
  void initState() {
    super.initState();
    _loadingDelay = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
      animationBehavior: AnimationBehavior.preserve,
    );
    _resolve();
  }

  @override
  void didUpdateWidget(MessageMarkdownImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.source != oldWidget.source ||
        widget.resolver != oldWidget.resolver) {
      _resolve();
    }
  }

  @override
  void dispose() {
    _loadingDelay.dispose();
    super.dispose();
  }

  void _resolve() {
    _loadingDelay.forward(from: 0);
    // Future.sync also turns a synchronous resolver throw into a failed state.
    _bytes = Future.sync(() => widget.resolver(widget.source));
  }

  String get _label => widget.alt.isEmpty ? 'Image' : widget.alt;

  Widget _status(String reason) =>
      Text('$_label · $reason', style: widget.style);

  Widget _loading() => Semantics(
    label: _label,
    image: true,
    child: SizedBox(
      width: 160,
      height: 80,
      child: AnimatedBuilder(
        animation: _loadingDelay,
        builder: (context, _) => _loadingDelay.isCompleted
            ? const _ImageSkeleton()
            : const SizedBox.expand(),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snapshot) {
        // A replacement future can retain old data. Never show or tap that data.
        if (snapshot.connectionState != ConnectionState.done) {
          return _loading();
        }
        if (snapshot.hasError || !snapshot.hasData) {
          final error = snapshot.error;
          return _status(
            error is MessageImageFailure
                ? error.label
                : MessageImageFailure.unavailable.label,
          );
        }
        final bytes = snapshot.requireData;
        return Image.memory(
          bytes,
          fit: BoxFit.contain,
          semanticLabel: _label,
          errorBuilder: (context, error, stackTrace) =>
              _status(MessageImageFailure.unsupported.label),
          frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
            if (frame == null && !wasSynchronouslyLoaded) {
              return _loading();
            }
            final onTap = widget.onTap;
            if (onTap == null) return child;
            void open() => onTap(widget.source, bytes);
            // Excluded child semantics drop the detector's tap, so the
            // button exposes the same action to screen readers.
            return Semantics(
              button: true,
              label: 'Open $_label',
              excludeSemantics: true,
              onTap: open,
              child: GestureDetector(
                onTap: open,
                behavior: HitTestBehavior.opaque,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minWidth: 44,
                    minHeight: 44,
                  ),
                  child: child,
                ),
              ),
            );
          },
        );
      },
    );
  }
}

/// Keeps table image content within a compact cell without changing resolution.
class MessageMarkdownImageThumbnail extends StatelessWidget {
  const MessageMarkdownImageThumbnail({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.topLeft,
    widthFactor: 1,
    heightFactor: 1,
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 96, maxHeight: 96),
      child: child,
    ),
  );
}

/// Only mounted while loading, so its ticker stops with success or failure.
class _ImageSkeleton extends StatefulWidget {
  const _ImageSkeleton();

  @override
  State<_ImageSkeleton> createState() => _ImageSkeletonState();
}

class _ImageSkeletonState extends State<_ImageSkeleton>
    with SingleTickerProviderStateMixin {
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
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: _pulse.drive(Tween(begin: 0.5, end: 1.0)),
    child: DecoratedBox(
      decoration: ShapeDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        shape: const StadiumBorder(),
      ),
    ),
  );
}
