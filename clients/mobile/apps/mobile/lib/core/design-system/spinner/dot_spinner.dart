import 'package:flutter/material.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Flutter ports of the shared desktop/web dot-grid spinners
/// (`packages/ui-shared/src/components/{Thinking,Loading,Run}Spinner.tsx` and
/// the keyframes in `canopy-tokens.css`): a 3×3 grid of round dots that pulse
/// opacity + scale on staggered delays. Nothing rotates.
///
/// Each keyframe table lists `(cycleFraction, opacity, scale)` stops; a dot's
/// phase is offset by its per-cell delay fraction, and segments interpolate
/// with an ease-in-out curve to match the CSS timing function.
enum DotSpinnerVariant {
  /// 0.9s symmetric column pulse rising from bottom-center — the desktop
  /// `ThinkingSpinner` used for agent thinking/streaming states.
  thinking,

  /// 1.2s clockwise perimeter march with a fading comet tail — the desktop
  /// `LoadingSpinner` used for generic loading states.
  loading,

  /// 1.2s anti-diagonal sweep, opposite corners firing together — the
  /// desktop `RunSpinner` used for pipeline/script run states.
  run,
}

/// Animated 3×3 dot-grid spinner. [size] is the total square footprint
/// (dot diameter and gaps each take 1/5 of it, matching the 2px dots + 2px
/// gaps of the 10px desktop original). [color] defaults to the operational
/// accent, mirroring desktop's `fg-accent` call sites.
class DotSpinner extends StatefulWidget {
  const DotSpinner({
    super.key,
    this.variant = DotSpinnerVariant.thinking,
    this.animate = true,
    this.size = 12,
    this.color,
  });

  final DotSpinnerVariant variant;

  /// List indicators can stay static so an idle screen schedules no frames.
  /// Reduced motion always takes precedence over this setting.
  final bool animate;
  final double size;
  final Color? color;

  @override
  State<DotSpinner> createState() => _DotSpinnerState();
}

/// Convenience wrapper matching desktop's `ThinkingSpinner`.
class ThinkingSpinner extends StatelessWidget {
  const ThinkingSpinner({
    super.key,
    this.size = 12,
    this.color,
    this.animate = true,
  });

  final double size;
  final Color? color;
  final bool animate;

  @override
  Widget build(BuildContext context) =>
      DotSpinner(size: size, color: color, animate: animate);
}

/// Convenience wrapper matching desktop's `LoadingSpinner`.
class LoadingSpinner extends StatelessWidget {
  const LoadingSpinner({super.key, this.size = 12, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      DotSpinner(variant: DotSpinnerVariant.loading, size: size, color: color);
}

/// Convenience wrapper matching desktop's `RunSpinner`.
class RunSpinner extends StatelessWidget {
  const RunSpinner({super.key, this.size = 12, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      DotSpinner(variant: DotSpinnerVariant.run, size: size, color: color);
}

class _DotSpinnerState extends State<DotSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _spec.duration,
  );
  bool _reduceMotion = false;

  _SpinnerSpec get _spec => _specs[widget.variant] ?? _thinkingSpec;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Under reduce-motion the grid renders a static frame instead of pulsing.
    // (This also lets widget tests pumpAndSettle over always-on spinners.)
    // Only re-sync when the setting actually changed — repeat() resets the
    // controller's phase, so an unconditional call would visibly restart
    // every spinner on any inherited-widget change.
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion == _reduceMotion && _controller.isAnimating) return;
    _reduceMotion = reduceMotion;
    _syncAnimation();
  }

  @override
  void didUpdateWidget(DotSpinner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.variant != widget.variant) {
      _controller.duration = _spec.duration;
    }
    if (oldWidget.variant != widget.variant ||
        oldWidget.animate != widget.animate) {
      _syncAnimation();
    }
  }

  void _syncAnimation() {
    if (_reduceMotion || !widget.animate) {
      _controller.stop();
    } else {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? StatusColors.of(context).accent;
    // The bare CustomPaint carries no accessibility information, unlike the
    // Material progress indicators it replaces — announce it explicitly.
    return Semantics(
      label: 'In progress',
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        // An always-on spinner repaints every frame. Without its own layer
        // that repaint dirties the enclosing list and, through it, the
        // blurred app bar over it, so an idle screen with one working row
        // re-rasterized the whole viewport at full frame rate.
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, _) => CustomPaint(
              painter: _DotGridPainter(
                spec: _spec,
                t: _controller.value,
                color: color,
                static: _reduceMotion || !widget.animate,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SpinnerSpec {
  const _SpinnerSpec({
    required this.duration,
    required this.delays,
    required this.keyframes,
  });

  final Duration duration;

  /// Per-cell start delay as a fraction of the cycle, in grid order
  /// (left→right, top→bottom). `null` hides the cell entirely (the
  /// perimeter/diagonal variants never light the center dot).
  final List<double?> delays;

  /// `(cycleFraction, opacity, scale)` stops.
  final List<(double, double, double)> keyframes;
}

// ThinkingSpinner.tsx: 6-step cycle 7→4→1→(0+2)→(3+5)→(6+8) at 0.9s;
// delays are multiples of 0.15s (1/6 cycle).
const _SpinnerSpec _thinkingSpec = _SpinnerSpec(
  duration: Duration(milliseconds: 900),
  delays: [3 / 6, 2 / 6, 3 / 6, 4 / 6, 1 / 6, 4 / 6, 5 / 6, 0, 5 / 6],
  keyframes: [
    (0, 0, 0),
    (0.03, 1, 1),
    (0.1667, 1, 1),
    (0.20, 0.55, 0.94),
    (0.3333, 0.55, 0.94),
    (0.37, 0.30, 0.90),
    (0.50, 0.30, 0.90),
    (0.53, 0.15, 0.85),
    (0.6667, 0.15, 0.85),
    (0.70, 0, 0),
    (1, 0, 0),
  ],
);

// LoadingSpinner.tsx: clockwise perimeter march 1→2→3→6→9→8→7→4 at 1.2s;
// 8 even delay steps of 1/8 cycle, center dot hidden.
const _SpinnerSpec _loadingSpec = _SpinnerSpec(
  duration: Duration(milliseconds: 1200),
  delays: [0, 1 / 8, 2 / 8, 7 / 8, null, 3 / 8, 6 / 8, 5 / 8, 4 / 8],
  keyframes: [
    (0, 0, 0),
    (0.02, 1, 1),
    (0.125, 1, 1),
    (0.15, 0.55, 0.94),
    (0.25, 0.55, 0.94),
    (0.275, 0.30, 0.90),
    (0.375, 0.30, 0.90),
    (0.40, 0.15, 0.85),
    (0.50, 0.15, 0.85),
    (0.525, 0, 0),
    (1, 0, 0),
  ],
);

// RunSpinner.tsx: anti-diagonal sweep (1+9)→(8+2)→(7+3)→(4+6) at 1.2s;
// 4 delay steps of 1/4 cycle, point-symmetric, center dot hidden.
const _SpinnerSpec _runSpec = _SpinnerSpec(
  duration: Duration(milliseconds: 1200),
  delays: [0, 1 / 4, 2 / 4, 3 / 4, null, 3 / 4, 2 / 4, 1 / 4, 0],
  keyframes: [
    (0, 0, 0),
    (0.03, 1, 1),
    (0.25, 1, 1),
    (0.28, 0.4, 0.92),
    (0.50, 0.15, 0.85),
    (0.53, 0, 0),
    (1, 0, 0),
  ],
);

const Map<DotSpinnerVariant, _SpinnerSpec> _specs = {
  DotSpinnerVariant.thinking: _thinkingSpec,
  DotSpinnerVariant.loading: _loadingSpec,
  DotSpinnerVariant.run: _runSpec,
};

class _DotGridPainter extends CustomPainter {
  const _DotGridPainter({
    required this.spec,
    required this.t,
    required this.color,
    this.static = false,
  });

  final _SpinnerSpec spec;
  final double t;
  final Color color;

  /// Reduce-motion rendering: every visible dot at a fixed mid opacity.
  final bool static;

  @override
  void paint(Canvas canvas, Size size) {
    // 3 dots + 2 gaps, each 1/5 of the footprint.
    final unit = size.shortestSide / 5;
    final radius = unit / 2;
    final paint = Paint();
    for (var index = 0; index < 9; index++) {
      final delay = spec.delays[index];
      if (delay == null) continue;
      final (opacity, scale) = static ? (0.55, 1.0) : _sample((t - delay) % 1);
      if (opacity <= 0 || scale <= 0) continue;
      final column = index % 3;
      final row = index ~/ 3;
      final center = Offset(
        column * 2 * unit + radius,
        row * 2 * unit + radius,
      );
      paint.color = color.withValues(alpha: color.a * opacity);
      canvas.drawCircle(center, radius * scale, paint);
    }
  }

  (double, double) _sample(double phase) {
    final frames = spec.keyframes;
    for (var i = 0; i < frames.length - 1; i++) {
      final (start, startOpacity, startScale) = frames[i];
      final (end, endOpacity, endScale) = frames[i + 1];
      if (phase < start || phase > end) continue;
      final span = end - start;
      final progress = span <= 0 ? 1.0 : (phase - start) / span;
      final eased = Curves.easeInOut.transform(progress.clamp(0, 1));
      return (
        startOpacity + (endOpacity - startOpacity) * eased,
        startScale + (endScale - startScale) * eased,
      );
    }
    final (_, opacity, scale) = frames.last;
    return (opacity, scale);
  }

  @override
  bool shouldRepaint(_DotGridPainter oldDelegate) =>
      oldDelegate.t != t ||
      oldDelegate.color != color ||
      oldDelegate.spec != spec ||
      oldDelegate.static != static;
}
