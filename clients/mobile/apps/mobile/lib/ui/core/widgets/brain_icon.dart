import 'package:flutter/material.dart';

/// The canonical Canopy thinking glyph — the two-lobed line-art brain shared
/// by the desktop (`ThinkingIcon` / `IconBrain2`) and web composers — drawn
/// from the same 24-viewBox SVG path data. Material has no brain glyph, so
/// this is a direct port rather than an `Icons.*` stand-in.
///
/// Stroke color defaults to the ambient [IconTheme] color, matching how
/// `Icon` resolves `currentColor`.
class BrainIcon extends StatelessWidget {
  const BrainIcon({super.key, this.size = 14, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final resolved =
        color ?? IconTheme.of(context).color ?? const Color(0xFF000000);
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _BrainPainter(color: resolved)),
    );
  }
}

class _BrainPainter extends CustomPainter {
  const _BrainPainter({required this.color});

  final Color color;

  // packages/ui-shared/src/icons/ThinkingIcon.tsx path data (24 viewBox).
  static const List<String> _paths = [
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588'
        'A4 4 0 1 0 12 18Z',
    'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588'
        'A4 4 0 1 1 12 18Z',
    'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  ];

  /// Parsed once — the path data is const, and `paint` runs per frame.
  static final List<Path> _parsedPaths = [
    for (final data in _paths) _parseSvgPath(data),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.shortestSide / 24;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      // ViewBox units: the canvas scale below converts to logical pixels.
      // (Scaling here too would double-apply the transform and render the
      // stroke near-hairline.)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    canvas.save();
    canvas.scale(scale);
    for (final path in _parsedPaths) {
      canvas.drawPath(path, paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_BrainPainter oldDelegate) => oldDelegate.color != color;
}

final RegExp _svgNumber = RegExp(r'[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?');

/// Minimal SVG path parser covering the command set the brain glyph uses:
/// absolute/relative moves (`M`/`m`), elliptical arcs (`A`/`a`, including
/// implicit repeats), and close (`Z`/`z`). Arcs map directly onto
/// [Path.arcToPoint], which implements the SVG endpoint-arc semantics.
Path _parseSvgPath(String data) {
  final path = Path();
  var x = 0.0;
  var y = 0.0;
  var index = 0;

  double nextNumber() {
    final match = _svgNumber.matchAsPrefix(data.substring(index).trimLeft());
    if (match == null) {
      throw FormatException('Expected number at $index in "$data"');
    }
    index = data.length - data.substring(index).trimLeft().length + match.end;
    return double.parse(match.group(0) ?? '0');
  }

  bool hasMoreNumbers() {
    final rest = data.substring(index).trimLeft();
    return rest.isNotEmpty && _svgNumber.matchAsPrefix(rest) != null;
  }

  while (index < data.length) {
    final char = data[index];
    if (char.trim().isEmpty || char == ',') {
      index++;
      continue;
    }
    switch (char) {
      case 'M' || 'm':
        final relative = char == 'm';
        index++;
        final nx = nextNumber();
        final ny = nextNumber();
        x = relative ? x + nx : nx;
        y = relative ? y + ny : ny;
        path.moveTo(x, y);
      case 'A' || 'a':
        final relative = char == 'a';
        index++;
        do {
          final rx = nextNumber();
          final ry = nextNumber();
          final rotation = nextNumber();
          final largeArc = nextNumber() != 0;
          final sweep = nextNumber() != 0;
          final ex = nextNumber();
          final ey = nextNumber();
          x = relative ? x + ex : ex;
          y = relative ? y + ey : ey;
          path.arcToPoint(
            Offset(x, y),
            radius: Radius.elliptical(rx, ry),
            rotation: rotation,
            largeArc: largeArc,
            clockwise: sweep,
          );
        } while (hasMoreNumbers());
      case 'Z' || 'z':
        index++;
        path.close();
      default:
        throw FormatException('Unsupported SVG command "$char" in "$data"');
    }
  }
  return path;
}
