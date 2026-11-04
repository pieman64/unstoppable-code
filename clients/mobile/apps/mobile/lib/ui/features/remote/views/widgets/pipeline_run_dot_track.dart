import 'package:flutter/material.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_display.dart';

/// A run's jobs as a horizontal track of status dots, grouped by dependency
/// tier, mirroring the desktop's `DagProgressBar`
/// (`packages/ui-shared/src/components/DagProgressBar.tsx`): one dot per
/// job, a quiet chip per tier with a separator between tiers, running dots
/// pulsing, and the track scrolled so the first running job is centered.
///
/// Overflow scrolls horizontally with a swipe. The overflowing edges fade
/// out and carry a chevron that steps the track, as on the desktop. The dots
/// themselves are not buttons: a tap falls through to the enclosing row.
class PipelineRunDotTrack extends StatefulWidget {
  const PipelineRunDotTrack({
    super.key,
    required this.executionId,
    required this.tiers,
    this.muted = false,
  });

  /// Scopes the dot keys, so two runs' tracks never share one.
  final String executionId;
  final List<List<PipelineRunDot>> tiers;

  /// Finished runs read quieter than the active one.
  final bool muted;

  static const double dotSize = 10;
  static const double dotGap = 5;

  /// How far one chevron tap scrolls, matching the desktop's `SCROLL_STEP`.
  static const double scrollStep = 80;

  @override
  State<PipelineRunDotTrack> createState() => _PipelineRunDotTrackState();
}

class _PipelineRunDotTrackState extends State<PipelineRunDotTrack>
    with SingleTickerProviderStateMixin {
  static const double _edgeFade = 20;
  static const double _overflowSlack = 2;

  final ScrollController _scroll = ScrollController();
  final GlobalKey _contentKey = GlobalKey();
  final Map<String, GlobalKey> _dotKeys = {};
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 2),
  );

  bool _overflowLeft = false;
  bool _overflowRight = false;

  /// The running job the track last centered, so it re-centers only when
  /// the work moves on rather than fighting the user's own scrolling.
  String? _centeredJobId;

  String? get _firstRunningJobId {
    for (final tier in widget.tiers) {
      for (final dot in tier) {
        if (dot.status == PipelineRunDotStatus.running) return dot.jobId;
      }
    }
    return null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncPulse();
    _scheduleCenterOnRunning();
  }

  @override
  void didUpdateWidget(covariant PipelineRunDotTrack oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
    _scheduleCenterOnRunning();
  }

  @override
  void dispose() {
    _pulse.dispose();
    _scroll.dispose();
    super.dispose();
  }

  bool get _animationsEnabled =>
      !MediaQuery.disableAnimationsOf(context) &&
      TickerMode.valuesOf(context).enabled;

  /// The pulse runs only while a job is running, so a finished run's track
  /// costs nothing, and never when the platform asks for reduced motion.
  void _syncPulse() {
    final pulsing = _firstRunningJobId != null && _animationsEnabled;
    if (pulsing && !_pulse.isAnimating) {
      _pulse.repeat();
    } else if (!pulsing && _pulse.isAnimating) {
      _pulse
        ..stop()
        ..value = 0;
    }
  }

  void _scheduleCenterOnRunning() {
    final jobId = _firstRunningJobId;
    if (jobId == null || jobId == _centeredJobId) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final dotBox = _dotKeys[jobId]?.currentContext?.findRenderObject();
      final contentBox = _contentKey.currentContext?.findRenderObject();
      if (dotBox is! RenderBox || contentBox is! RenderBox) return;
      _centeredJobId = jobId;
      final position = _scroll.position;
      final dotCenter =
          dotBox.localToGlobal(Offset.zero, ancestor: contentBox).dx +
          PipelineRunDotTrack.dotSize / 2;
      final target = (dotCenter - position.viewportDimension / 2).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      // Scrolls only this track: `Scrollable.ensureVisible` would also move
      // the sidebar list that contains it.
      if (_animationsEnabled) {
        _scroll.animateTo(
          target,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      } else {
        _scroll.jumpTo(target);
      }
    });
  }

  bool _onMetrics(ScrollMetrics metrics) {
    final left = metrics.pixels > metrics.minScrollExtent + _overflowSlack;
    final right = metrics.pixels < metrics.maxScrollExtent - _overflowSlack;
    if (left != _overflowLeft || right != _overflowRight) {
      setState(() {
        _overflowLeft = left;
        _overflowRight = right;
      });
    }
    return false;
  }

  void _step(double delta) {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    final target = (position.pixels + delta).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (_animationsEnabled) {
      _scroll.animateTo(
        target,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    } else {
      _scroll.jumpTo(target);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ink = theme.colorScheme.onSurface;
    final liveIds = {
      for (final tier in widget.tiers)
        for (final dot in tier) dot.jobId,
    };
    _dotKeys.removeWhere((id, _) => !liveIds.contains(id));

    final content = Row(
      key: _contentKey,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var index = 0; index < widget.tiers.length; index++) ...[
          if (index > 0)
            Container(
              width: 3,
              height: 3,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              decoration: BoxDecoration(
                color: ink.withValues(alpha: 0.2),
                shape: BoxShape.circle,
              ),
            ),
          Container(
            key: ValueKey('pipeline-run-dot-tier:$index'),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
            decoration: BoxDecoration(
              color: ink.withValues(alpha: 0.05),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              spacing: PipelineRunDotTrack.dotGap,
              children: [
                for (final dot in widget.tiers[index])
                  _Dot(
                    key: _dotKeys.putIfAbsent(dot.jobId, GlobalKey.new),
                    testKey: ValueKey(
                      'pipeline-run-dot:${widget.executionId}:${dot.jobId}',
                    ),
                    status: dot.status,
                    pulse: _pulse,
                  ),
              ],
            ),
          ),
        ],
      ],
    );

    final track = NotificationListener<ScrollMetricsNotification>(
      onNotification: (notification) => _onMetrics(notification.metrics),
      child: NotificationListener<ScrollNotification>(
        onNotification: (notification) => _onMetrics(notification.metrics),
        child: SingleChildScrollView(
          controller: _scroll,
          scrollDirection: Axis.horizontal,
          child: content,
        ),
      ),
    );

    return Opacity(
      opacity: widget.muted ? 0.7 : 1,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // A mask rather than a painted gradient, so the fade works on
          // whatever surface the track sits on.
          ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (bounds) {
              final edge = bounds.width <= 0
                  ? 0.0
                  : (_edgeFade / bounds.width).clamp(0.0, 0.5);
              return LinearGradient(
                colors: [
                  _overflowLeft ? Colors.transparent : Colors.black,
                  Colors.black,
                  Colors.black,
                  _overflowRight ? Colors.transparent : Colors.black,
                ],
                stops: [0, edge, 1 - edge, 1],
              ).createShader(bounds);
            },
            child: track,
          ),
          if (_overflowLeft)
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              child: _Chevron(
                key: const ValueKey('pipeline-run-dots-scroll-left'),
                icon: Icons.chevron_left,
                onTap: () => _step(-PipelineRunDotTrack.scrollStep),
              ),
            ),
          if (_overflowRight)
            Positioned(
              right: 0,
              top: 0,
              bottom: 0,
              child: _Chevron(
                key: const ValueKey('pipeline-run-dots-scroll-right'),
                icon: Icons.chevron_right,
                onTap: () => _step(PipelineRunDotTrack.scrollStep),
              ),
            ),
        ],
      ),
    );
  }
}

/// The same dots inline, for a background tray row, mirroring the desktop's
/// `DagProgressDots`: no tier chips, a hairline between tiers, and no
/// scrolling. Overflow is clipped, and the strip is hidden from semantics
/// because the row names the run's state and its inspector holds the track.
class PipelineRunDotStrip extends StatelessWidget {
  const PipelineRunDotStrip({
    super.key,
    required this.executionId,
    required this.tiers,
  });

  final String executionId;
  final List<List<PipelineRunDot>> tiers;

  static const double dotSize = 8;

  @override
  Widget build(BuildContext context) {
    final ink = Theme.of(context).colorScheme.onSurface;
    return ExcludeSemantics(
      child: UnconstrainedBox(
        alignment: AlignmentDirectional.centerStart,
        constrainedAxis: Axis.vertical,
        clipBehavior: Clip.hardEdge,
        child: Row(
          key: ValueKey('pipeline-run-dot-strip:$executionId'),
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var index = 0; index < tiers.length; index++) ...[
              if (index > 0)
                Container(
                  key: ValueKey('pipeline-run-dot-strip-hairline:$index'),
                  width: 6,
                  height: 1,
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  color: ink.withValues(alpha: 0.2),
                ),
              for (final (dotIndex, dot) in tiers[index].indexed) ...[
                if (dotIndex > 0) const SizedBox(width: 3),
                _Dot(
                  testKey: ValueKey(
                    'pipeline-run-strip-dot:$executionId:${dot.jobId}',
                  ),
                  status: dot.status,
                  pulse: kAlwaysCompleteAnimation,
                  size: dotSize,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({
    super.key,
    required this.testKey,
    required this.status,
    required this.pulse,
    this.size = PipelineRunDotTrack.dotSize,
  });

  final Key testKey;
  final PipelineRunDotStatus status;
  final Animation<double> pulse;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = StatusColors.of(context);
    // The desktop's `getDotColorClass`: waiting, paused and stopped jobs
    // share the secondary ink, told apart by how faint they are.
    final color = switch (status) {
      PipelineRunDotStatus.running => colors.active,
      PipelineRunDotStatus.success => colors.success,
      PipelineRunDotStatus.failure => colors.failed,
      PipelineRunDotStatus.cancelled => colors.neutral.withValues(alpha: 0.6),
      PipelineRunDotStatus.skipped => colors.neutral.withValues(alpha: 0.4),
      PipelineRunDotStatus.paused ||
      PipelineRunDotStatus.pending => colors.neutral,
    };
    final dot = Container(
      key: testKey,
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
    if (status != PipelineRunDotStatus.running) return dot;
    return FadeTransition(opacity: pulse.drive(_pulseOpacity), child: dot);
  }

  /// Tailwind's `animate-pulse`: full opacity, down to half, and back.
  static final Animatable<double> _pulseOpacity = TweenSequence<double>([
    TweenSequenceItem(
      tween: Tween<double>(
        begin: 1,
        end: 0.5,
      ).chain(CurveTween(curve: Curves.easeInOut)),
      weight: 1,
    ),
    TweenSequenceItem(
      tween: Tween<double>(
        begin: 0.5,
        end: 1,
      ).chain(CurveTween(curve: Curves.easeInOut)),
      weight: 1,
    ),
  ]);
}

class _Chevron extends StatelessWidget {
  const _Chevron({super.key, required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: SizedBox(
        width: 20,
        child: Icon(
          icon,
          size: 14,
          color: Theme.of(
            context,
          ).colorScheme.onSurface.withValues(alpha: 0.45),
        ),
      ),
    );
  }
}
