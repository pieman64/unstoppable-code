import 'package:mobile/services/analytics/product_analytics.dart';

/// Records every capture in order, for asserting exact funnel events.
final class RecordingProductAnalytics implements ProductAnalytics {
  final List<({String event, Map<String, Object> properties})> events = [];

  List<String> get names => [for (final e in events) e.event];

  @override
  void capture(String event, Map<String, Object> properties) {
    events.add((event: event, properties: Map.unmodifiable(properties)));
  }
}
