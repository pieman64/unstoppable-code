import 'package:flutter/widgets.dart';

/// Hands back a list row's previous widget while the inputs it was built
/// from are unchanged.
///
/// Flutter skips an element whose new widget is the identical object, so an
/// unchanged row costs nothing when its list rebuilds — keys alone only keep
/// its element. The row still rebuilds for its own state and inherited
/// dependencies (theme, scopes), which never pass through the cache.
class RowWidgetCache {
  final Map<String, ({Object? inputs, Widget widget})> _rows = {};

  /// The widget for row [key]: the cached one when [inputs] equal those it
  /// was built from, else a fresh one from [build].
  Widget obtain(String key, Object? inputs, Widget Function() build) {
    final cached = _rows[key];
    if (cached != null && cached.inputs == inputs) return cached.widget;
    final widget = build();
    _rows[key] = (inputs: inputs, widget: widget);
    return widget;
  }

  /// Forgets every row for which [keep] is false.
  void retainWhere(bool Function(String key) keep) =>
      _rows.removeWhere((key, _) => !keep(key));
}
