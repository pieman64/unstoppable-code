import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';

/// Exposes the owning surface's [AttachmentThumbnailCache] to the transcript.
///
/// An [InheritedNotifier] rather than a `ChatFeed` parameter: the chips that
/// read it sit several layers below the feed, and a retain that resolves
/// after a bubble is already on screen has to rebuild just those chips.
/// Absent scope means no previews, which is the correct reading for any
/// surface that never staged bytes of its own.
class AttachmentThumbnailScope
    extends InheritedNotifier<AttachmentThumbnailCache> {
  const AttachmentThumbnailScope({
    super.key,
    required AttachmentThumbnailCache thumbnails,
    required super.child,
  }) : super(notifier: thumbnails);

  static AttachmentThumbnailCache? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<AttachmentThumbnailScope>()
      ?.notifier;
}
