import 'package:in_app_review/in_app_review.dart';

enum StoreReviewRequestResult { requested, unavailable }

/// Requests the platform-native in-app review sheet (StoreKit on iOS, the
/// Play In-App Review API on Android). The OS decides whether the sheet is
/// actually shown and never reports whether a rating was submitted.
abstract interface class StoreReviewLauncher {
  Future<StoreReviewRequestResult> request();
}

final class InAppReviewLauncher implements StoreReviewLauncher {
  InAppReviewLauncher({
    Future<bool> Function()? isAvailable,
    Future<void> Function()? requestReview,
  }) : _isAvailable = isAvailable ?? InAppReview.instance.isAvailable,
       _requestReview = requestReview ?? InAppReview.instance.requestReview;

  final Future<bool> Function() _isAvailable;
  final Future<void> Function() _requestReview;

  /// Never opens the store listing: when the review sheet is unavailable the
  /// user simply stays where they are.
  @override
  Future<StoreReviewRequestResult> request() async {
    try {
      if (!await _isAvailable()) return StoreReviewRequestResult.unavailable;
      await _requestReview();
      return StoreReviewRequestResult.requested;
    } catch (_) {
      return StoreReviewRequestResult.unavailable;
    }
  }
}
