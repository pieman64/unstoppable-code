import 'dart:ui';

import 'package:share_plus/share_plus.dart';

/// Opens the platform share sheet with a short message.
abstract interface class LinkSharer {
  /// [origin] anchors the share popover on iPad, in global coordinates.
  Future<void> share({required String text, String? subject, Rect? origin});
}

final class SharePlusLinkSharer implements LinkSharer {
  SharePlusLinkSharer({Future<ShareResult> Function(ShareParams params)? share})
    : _share = share ?? SharePlus.instance.share;

  final Future<ShareResult> Function(ShareParams params) _share;

  @override
  Future<void> share({
    required String text,
    String? subject,
    Rect? origin,
  }) async {
    await _share(
      ShareParams(text: text, subject: subject, sharePositionOrigin: origin),
    );
  }
}
