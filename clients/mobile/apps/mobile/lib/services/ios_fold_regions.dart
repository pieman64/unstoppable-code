import 'package:flutter/services.dart';

/// Geometry is in logical points relative to the owning Flutter view.
class IosFoldRegions {
  const IosFoldRegions({required this.size, required this.regions});

  final Size size;
  final List<Rect> regions;

  static IosFoldRegions decode(Object? message) {
    if (message case {
      'width': final num width,
      'height': final num height,
      'regions': final List<Object?> regions,
    }) {
      return IosFoldRegions(
        size: Size(width.toDouble(), height.toDouble()),
        regions: [
          for (final region in regions)
            if (region case {
              'x': final num x,
              'y': final num y,
              'width': final num w,
              'height': final num h,
            })
              Rect.fromLTWH(
                x.toDouble(),
                y.toDouble(),
                w.toDouble(),
                h.toDouble(),
              ),
        ],
      );
    }
    throw const FormatException('Invalid iOS fold geometry');
  }

  static Stream<IosFoldRegions> observe() => const EventChannel(
    'com.unstoppabledomains.canopy/fold_regions',
  ).receiveBroadcastStream().map(decode);
}
