import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';

/// Staged attachments above the draft: one chip per file with an upload
/// ring, a retry action after a failure, and a remove control. Renders
/// nothing while the controller has no drafts.
class AttachmentStrip extends StatelessWidget {
  const AttachmentStrip({super.key, required this.controller});

  final ChatAttachmentController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final drafts = controller.drafts;
        if (drafts.isEmpty) return const SizedBox.shrink();
        return SizedBox(
          key: const ValueKey('attachment-strip'),
          height: 56,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 4),
            itemCount: drafts.length,
            separatorBuilder: (_, _) => const SizedBox(width: 6),
            itemBuilder: (context, index) {
              final draft = drafts[index];
              return _AttachmentChip(
                key: ValueKey('attachment-chip-${draft.localId}'),
                draft: draft,
                onRetry: () => unawaited(controller.retry(draft.localId)),
                onRemove: () => unawaited(controller.remove(draft.localId)),
              );
            },
          ),
        );
      },
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({
    super.key,
    required this.draft,
    required this.onRetry,
    required this.onRemove,
  });

  final ChatAttachmentDraft draft;
  final VoidCallback onRetry;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final error = Theme.of(context).colorScheme.error;
    final failed = draft.status == ChatAttachmentStatus.failed;
    final uploading = draft.status == ChatAttachmentStatus.uploading;
    final uploadError = draft.error;
    // The chip is the durable home for the reason an upload failed: the
    // snackbar is one-shot, and a long-press/hover has to be able to recover
    // it. `Tooltip` doubles as the screen-reader hint.
    final failureHint = failed && uploadError != null && uploadError.isNotEmpty
        ? uploadError
        : null;
    final chip = Semantics(
      label: failed
          ? '${draft.filename}, upload failed'
          : uploading
          ? '${draft.filename}, uploading'
          : draft.filename,
      hint: failureHint,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 220),
        padding: const EdgeInsets.fromLTRB(8, 4, 4, 4),
        decoration: BoxDecoration(
          color: colors.surface,
          border: Border.all(
            color: failed ? error.withValues(alpha: 0.6) : colors.border,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (draft.isImage)
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Image.memory(
                  draft.bytes,
                  width: 32,
                  height: 32,
                  cacheWidth: (32 * MediaQuery.devicePixelRatioOf(context))
                      .round(),
                  cacheHeight: (32 * MediaQuery.devicePixelRatioOf(context))
                      .round(),
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  // A staged pick can be a partially-read or corrupt file;
                  // fall back to the generic glyph instead of the default
                  // (unbounded) error placeholder blowing out the chip's
                  // fixed-width layout.
                  errorBuilder: (context, error, stackTrace) => SizedBox(
                    width: 32,
                    height: 32,
                    child: CanopyIcon(
                      glyph: CanopyGlyph.pageAttachment,
                      size: 20,
                      tint: colors.foregroundSecondary,
                    ),
                  ),
                ),
              )
            else
              CanopyIcon(
                glyph: CanopyGlyph.pageAttachment,
                size: 20,
                tint: colors.foregroundSecondary,
              ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                draft.filename,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body.copyWith(color: colors.foreground),
              ),
            ),
            const SizedBox(width: 4),
            if (uploading)
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            if (failed)
              CanopyIconButton(
                key: ValueKey('attachment-retry-${draft.localId}'),
                glyph: CanopyGlyph.arrowRotateClockwise,
                tooltip: 'Retry upload',
                size: CanopyIconButtonSize.small,
                tint: error,
                onPressed: onRetry,
              ),
            CanopyIconButton(
              key: ValueKey('attachment-remove-${draft.localId}'),
              glyph: CanopyGlyph.crossSmall,
              tooltip: 'Remove attachment',
              size: CanopyIconButtonSize.small,
              onPressed: onRemove,
            ),
          ],
        ),
      ),
    );
    return failureHint == null
        ? chip
        : Tooltip(
            key: ValueKey('attachment-error-${draft.localId}'),
            message: failureHint,
            excludeFromSemantics: true,
            triggerMode: TooltipTriggerMode.tap,
            child: chip,
          );
  }
}
