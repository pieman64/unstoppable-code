import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/ui/features/feed/view_models/feed_sharing_guidance.dart';

/// Explains why the viewer's own work may be missing from a team's Activity,
/// from the viewer's data-sharing evidence. Copy follows docs/ux-writing.md
/// ("Data-sharing opt-in hints", mobile). Mobile cannot change sharing, so the
/// offer points at the desktop app and, when the account has one, at Personal
/// Activity, where private work appears.
class FeedSharingNotice extends StatelessWidget {
  const FeedSharingNotice({
    super.key,
    required this.guidance,
    this.organizationName,
    this.onViewPersonal,
  });

  final FeedSharingGuidance guidance;

  /// The selected team's name, for organization-managed sharing.
  final String? organizationName;

  /// Selects Personal Activity; null when the account has no Personal.
  final VoidCallback? onViewPersonal;

  @override
  Widget build(BuildContext context) {
    return switch (guidance) {
      FeedSharingGuidance.none => const SizedBox.shrink(),
      FeedSharingGuidance.managed => InlineNotice(
        key: const ValueKey('feed-sharing-managed'),
        glyph: CanopyGlyph.lock,
        state:
            '${organizationName ?? 'Your organization'} manages '
            'this sharing.',
      ),
      FeedSharingGuidance.offer => InlineNotice(
        key: const ValueKey('feed-sharing-offer'),
        glyph: CanopyGlyph.eyeSlash,
        state: 'Share your work in the feed.',
        explanation:
            'Turn this on in the ${Brand.productDisplayName} desktop app. '
            'Personal work stays private.',
        actions: [
          if (onViewPersonal case final onPressed?)
            (
              label: 'View Personal',
              glyph: CanopyGlyph.user,
              onPressed: onPressed,
            ),
        ],
      ),
    };
  }
}
