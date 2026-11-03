import 'dart:collection';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// Thumbnails for images this device attached to a message, kept in memory so
/// the transcript can preview what was sent instead of only naming it.
///
/// The bytes never come back from anywhere: the web relay deletes an uploaded
/// blob the moment the paired desktop pulls it, and the desktop's own echo
/// carries `path-<hash>` ids that resolve to no byte source. What this cache
/// holds is the copy the composer already had in hand at send time, keyed by
/// the cloud `attachmentId` — which survives the desktop echo, because the
/// view model keeps the optimistic bubble's attachment list when the echoed
/// message describes the same files.
///
/// Everything else falls back to the plain filename chip: history paged in
/// from the desktop, attachments added on the desktop, a different phone, and
/// this phone after a restart. That is the deliberate bound of an in-memory
/// cache, not a gap to paper over.
class AttachmentThumbnailCache extends ChangeNotifier {
  AttachmentThumbnailCache({
    this.maxEntries = defaultMaxEntries,
    this.maxDimension = defaultMaxDimension,
  }) : assert(maxEntries > 0),
       assert(maxDimension > 0);

  /// Entries are a few kilobytes each once downscaled, so the cap is about
  /// bounding unbounded growth over a long session, not about byte pressure.
  static const int defaultMaxEntries = 64;

  /// Longest edge of a retained thumbnail, in logical pixels. The transcript
  /// chip paints it at 32pt, so this covers a 3x screen with room to spare.
  static const int defaultMaxDimension = 128;

  final int maxEntries;
  final int maxDimension;

  /// Insertion-ordered so the oldest retained thumbnail is the one evicted.
  final LinkedHashMap<String, Uint8List> _thumbnails =
      LinkedHashMap<String, Uint8List>();
  int _generation = 0;
  bool _disposed = false;

  /// The retained thumbnail for [attachmentId], or null when this device
  /// never sent those bytes (or has since evicted them).
  Uint8List? thumbnailFor(String attachmentId) => _thumbnails[attachmentId];

  /// Decodes, downscales and retains [bytes] for [attachmentId].
  ///
  /// Non-images and bytes that will not decode are dropped silently: a
  /// preview is a nicety, and a corrupt or exotic pick must never take down
  /// the send it was attached to. Already-retained ids are a no-op, so a
  /// resend does not re-decode or rebuild every chip on screen.
  Future<void> retain({
    required String attachmentId,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    if (_disposed) return;
    if (attachmentId.isEmpty) return;
    if (!mediaType.startsWith('image/')) return;
    if (_thumbnails.containsKey(attachmentId)) return;

    final generation = _generation;
    final thumbnail = await _encodeThumbnail(bytes, maxDimension);
    if (thumbnail == null || _disposed || generation != _generation) return;
    // `retain` awaited a decode, so re-check: a concurrent send may have
    // landed the same id while this one was off in the codec.
    if (_thumbnails.containsKey(attachmentId)) return;

    _thumbnails[attachmentId] = thumbnail;
    while (_thumbnails.length > maxEntries) {
      _thumbnails.remove(_thumbnails.keys.first);
    }
    notifyListeners();
  }

  void clear() {
    _generation += 1;
    if (_thumbnails.isEmpty) return;
    _thumbnails.clear();
    if (_disposed) return;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    _thumbnails.clear();
    super.dispose();
  }
}

/// Re-encodes [bytes] as a PNG whose longest edge is at most [maxDimension],
/// or null when the bytes are not a decodable image. Never upscales.
Future<Uint8List?> _encodeThumbnail(Uint8List bytes, int maxDimension) async {
  if (bytes.isEmpty) return null;
  ui.ImmutableBuffer? buffer;
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    final width = descriptor.width;
    final height = descriptor.height;
    if (width <= 0 || height <= 0) return null;
    // Constrain the longer edge only; `instantiateCodec` scales the other
    // one by the true aspect ratio, so nothing is squashed.
    final constrainWidth = width >= height;
    final longest = constrainWidth ? width : height;
    final target = longest <= maxDimension ? longest : maxDimension;
    codec = await descriptor.instantiateCodec(
      targetWidth: constrainWidth ? target : null,
      targetHeight: constrainWidth ? null : target,
    );
    final frame = await codec.getNextFrame();
    image = frame.image;
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  } catch (_) {
    // Undecodable, unsupported, or truncated bytes: no preview, no failure.
    return null;
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer?.dispose();
  }
}
