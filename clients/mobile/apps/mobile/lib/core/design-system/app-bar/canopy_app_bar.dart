import 'dart:math' as math;
import 'dart:ui';

import '../icon-button/canopy_icon_button.dart';
import '../icon/canopy_glyph.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Floating chrome with a safe-area-centered content slot and two action slots.
/// Top and horizontal system insets are applied here, never around the body.
class CanopyAppBar extends StatelessWidget {
  const CanopyAppBar({
    super.key,
    required this.content,
    this.subtitle,
    this.leading,
    this.automaticallyImplyLeading = false,
    this.trailing,
    this.toolbarHeight = defaultToolbarHeight,
    this.actionExtent = 48,
    this.blurSigma = 1.5,
  });

  final Widget content;

  /// Optional secondary context displayed below the primary content.
  final Widget? subtitle;
  final Widget? leading;
  final bool automaticallyImplyLeading;
  final Widget? trailing;

  /// Above [defaultToolbarHeight] the caller has grown the bar to fit
  /// wrapped content, and the bar adds [grownFadeExtent] below it.
  final double toolbarHeight;

  /// Equal space on each side keeps content centered even with one action.
  /// Increase this for wider leading or trailing widgets.
  final double actionExtent;

  /// Kept low on purpose: the background gradient below does most of the work
  /// separating the bar from the content, and the blur now runs at a uniform
  /// sigma across the whole bar, so a heavy value leaves a hard focus seam
  /// where the bar ends.
  final double blurSigma;

  /// Bottom clearance between the visible action row and the app-bar edge.
  static const fadeHeight = 8.0;

  static const defaultToolbarHeight = 56.0;

  /// The band below a grown toolbar that the scrim fades out across. A
  /// default bar fades through its lower half, behind one line of content; a
  /// grown bar would fade behind its later lines and the actions, so it holds
  /// the scrim through the whole toolbar and fades below it instead.
  static const grownFadeExtent = 24.0;

  /// Peak opacity of the background scrim, and the single knob for how solid
  /// the chrome reads. Deliberately below 1 so the upper half remains
  /// translucent while the lower half fades continuously to zero.
  static const maxScrimAlpha = 0.95;

  double _toolbarHeight(BuildContext context) {
    if (subtitle == null) return toolbarHeight;
    final typography = Theme.of(context).textTheme;
    final scaler = MediaQuery.textScalerOf(context);
    double lineHeight(TextStyle style) =>
        scaler.scale(style.fontSize!) * (style.height ?? 1);
    return math.max(
      toolbarHeight,
      lineHeight(typography.titleMedium!) +
          lineHeight(typography.bodySmall!) +
          8,
    );
  }

  double get _fadeExtent =>
      toolbarHeight > defaultToolbarHeight ? grownFadeExtent : 0;

  double height(BuildContext context) =>
      MediaQuery.paddingOf(context).top + _toolbarHeight(context) + _fadeExtent;

  /// Horizontal padding outside the action slots and around the content.
  static const _edgePadding = 8.0;
  static const _contentPadding = 8.0;

  /// The width [content] lays out in, for screens that size [toolbarHeight]
  /// to wrapped content.
  double contentWidth(BuildContext context) =>
      MediaQuery.sizeOf(context).width -
      MediaQuery.paddingOf(context).horizontal -
      2 * (_edgePadding + actionExtent + _contentPadding);

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final padding = MediaQuery.paddingOf(context);
    final barHeight = height(context);
    final holdStop = _fadeExtent == 0
        ? 0.5
        : (barHeight - _fadeExtent) / barHeight;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value:
          (Theme.of(context).brightness == Brightness.dark
                  ? SystemUiOverlayStyle.light
                  : SystemUiOverlayStyle.dark)
              .copyWith(
                statusBarColor: Colors.transparent,
                systemStatusBarContrastEnforced: false,
              ),
      child: SizedBox(
        height: barHeight,
        child: Stack(
          children: [
            Positioned.fill(
              child: IgnorePointer(
                child: ClipRect(
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      // Exactly one BackdropFilter: each costs a full
                      // framebuffer readback plus blur passes on the raster
                      // thread for every frame content moves underneath it,
                      // and eight stacked bands halved scroll frame rate on
                      // device. The gradient below, not a varying sigma, is
                      // what softens the bar into the content.
                      if (blurSigma > 0)
                        BackdropFilter(
                          filter: ImageFilter.blur(
                            sigmaX: blurSigma,
                            sigmaY: blurSigma,
                          ),
                          child: const SizedBox.expand(),
                        ),
                      DecoratedBox(
                        decoration: BoxDecoration(
                          // Carries the separation the tapered blur used to:
                          // Transparent at the bottom, rising continuously to
                          // the peak tint at mid-bar (or, for a grown bar, at
                          // the toolbar's bottom) and holding above it.
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              colors.background.withValues(
                                alpha: maxScrimAlpha,
                              ),
                              colors.background.withValues(
                                alpha: maxScrimAlpha,
                              ),
                              colors.background.withValues(alpha: 0),
                            ],
                            stops: [0, holdStop, 1],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(
                _edgePadding + padding.left,
                padding.top,
                _edgePadding + padding.right,
                0,
              ),
              child: SizedBox(
                height: _toolbarHeight(context),
                child: Row(
                  children: [
                    SizedBox(
                      width: actionExtent,
                      child: Center(
                        child:
                            leading ??
                            (automaticallyImplyLeading &&
                                    Navigator.of(context).canPop()
                                ? CanopyIconButton(
                                    glyph: CanopyGlyph.arrowLeft,
                                    tooltip: MaterialLocalizations.of(
                                      context,
                                    ).backButtonTooltip,
                                    onPressed: () =>
                                        Navigator.of(context).maybePop(),
                                  )
                                : null),
                      ),
                    ),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: _contentPadding,
                        ),
                        child: DefaultTextStyle(
                          style: Theme.of(context).textTheme.titleMedium!
                              .copyWith(color: colors.foreground),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.center,
                          child: Center(
                            child: subtitle == null
                                ? content
                                : Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      content,
                                      DefaultTextStyle(
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodySmall!
                                            .copyWith(
                                              color: colors.foregroundSecondary,
                                            ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        textAlign: TextAlign.center,
                                        child: subtitle!,
                                      ),
                                    ],
                                  ),
                          ),
                        ),
                      ),
                    ),
                    SizedBox(
                      width: actionExtent,
                      child: Center(child: trailing),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
