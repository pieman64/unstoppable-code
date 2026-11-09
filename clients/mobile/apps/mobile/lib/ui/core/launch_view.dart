import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';

/// The first Flutter screen, shown while the saved session is restored.
///
/// It continues the native launch screen rather than replacing it: the same
/// app-icon tile, at the same size and position, on the same background (see
/// the `flutter_native_splash` section of `pubspec.yaml`). When Flutter draws
/// its first frame and the OS removes the native splash, nothing visibly
/// changes. A spinner fades in below the tile only if startup is slow, so a
/// stalled network never looks like a frozen app.
class LaunchView extends StatefulWidget {
  const LaunchView({super.key});

  static const String markAsset = 'assets/splash/splash_mark.png';

  /// Logical size of the [markAsset] tile; the native splash draws it at the
  /// same size.
  static const double markSize = 144;

  static const Duration spinnerDelay = Duration(milliseconds: 1200);

  static const Key markKey = ValueKey('launch-mark');

  /// Decodes [markAsset] into the image cache ahead of `runApp`, so the first
  /// frame paints the mark instead of an empty background.
  static Future<void> precacheMark() {
    final done = Completer<void>();
    final stream = const AssetImage(
      markAsset,
    ).resolve(ImageConfiguration.empty);
    late final ImageStreamListener listener;
    void finish() {
      if (done.isCompleted) return;
      done.complete();
      // Stay subscribed until the first frame has taken its own listener, as
      // `precacheImage` does, so the cache cannot drop the decoded image.
      SchedulerBinding.instance.addPostFrameCallback(
        (_) => stream.removeListener(listener),
      );
    }

    listener = ImageStreamListener(
      (_, _) => finish(),
      // A missing mark only costs the launch view its artwork.
      onError: (_, _) => finish(),
    );
    stream.addListener(listener);
    return done.future;
  }

  @override
  State<LaunchView> createState() => _LaunchViewState();
}

class _LaunchViewState extends State<LaunchView> {
  Timer? _spinnerTimer;
  bool _showSpinner = false;

  @override
  void initState() {
    super.initState();
    _spinnerTimer = Timer(LaunchView.spinnerDelay, () {
      if (mounted) setState(() => _showSpinner = true);
    });
  }

  @override
  void dispose() {
    _spinnerTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Fill the whole window: the native splash centers on the full screen,
      // not the area below the status bar.
      body: Stack(
        fit: StackFit.expand,
        alignment: Alignment.center,
        children: [
          Center(
            child: Image.asset(
              LaunchView.markAsset,
              key: LaunchView.markKey,
              width: LaunchView.markSize,
              height: LaunchView.markSize,
              excludeFromSemantics: true,
            ),
          ),
          if (_showSpinner)
            Center(
              child: Transform.translate(
                offset: const Offset(0, LaunchView.markSize / 2 + 48),
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: const Duration(milliseconds: 250),
                  builder: (context, opacity, child) =>
                      Opacity(opacity: opacity, child: child),
                  child: const LoadingSpinner(size: 22),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
