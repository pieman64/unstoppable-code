import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';

/// Composer microphone, sized and shaped like the toolbar's plan and fast
/// controls. State styling mirrors desktop `VoiceInputButton`: a plain mic
/// while idle, a progress ring while the microphone opens, the stop tint
/// while listening, and a faded error tint after a failure so the next tap
/// reads as a retry. [tooltip] doubles as the accessible label.
class VoiceDictationButton extends StatelessWidget {
  const VoiceDictationButton({
    super.key,
    required this.state,
    required this.onPressed,
  });

  static const double dimension = 32;

  final VoiceDictationState state;
  final VoidCallback? onPressed;

  String get tooltip => switch (state) {
    VoiceDictationState.idle => 'Start voice dictation',
    VoiceDictationState.connecting => 'Starting microphone…',
    VoiceDictationState.listening => 'Stop dictation',
    VoiceDictationState.error => 'Start voice dictation',
  };

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final error = Theme.of(context).colorScheme.error;
    final listening = state == VoiceDictationState.listening;
    final foreground = switch (state) {
      VoiceDictationState.listening => error.withValues(alpha: 0.7),
      VoiceDictationState.error => error.withValues(alpha: 0.7),
      _ => colors.foregroundSecondary,
    };
    final enabled = onPressed != null;
    return Material(
      type: MaterialType.transparency,
      child: IconButton(
        tooltip: tooltip,
        isSelected: listening,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          backgroundColor: listening
              ? error.withValues(alpha: 0.1)
              : Colors.transparent,
          disabledBackgroundColor: listening
              ? error.withValues(alpha: 0.1)
              : Colors.transparent,
          foregroundColor: foreground,
          disabledForegroundColor: colors.disabledTint,
          highlightColor: colors.foreground.withValues(alpha: 0.12),
          hoverColor: colors.foreground.withValues(alpha: 0.08),
          focusColor: colors.focus.withValues(alpha: 0.16),
          padding: EdgeInsets.zero,
          minimumSize: const Size.square(dimension),
          fixedSize: const Size.square(dimension),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.standard,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
          ),
        ).copyWith(splashFactory: InkRipple.splashFactory),
        icon: state == VoiceDictationState.connecting
            ? SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: foreground,
                ),
              )
            : CanopyIcon(
                glyph: CanopyGlyph.microphone,
                size: 16,
                tint: enabled ? foreground : colors.disabledTint,
              ),
      ),
    );
  }
}
