import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/store_review_launcher.dart';

void main() {
  test('requests the review when available', () async {
    var requests = 0;
    final launcher = InAppReviewLauncher(
      isAvailable: () async => true,
      requestReview: () async => requests++,
    );
    expect(await launcher.request(), StoreReviewRequestResult.requested);
    expect(requests, 1);
  });

  test('does nothing when unavailable', () async {
    var requests = 0;
    final launcher = InAppReviewLauncher(
      isAvailable: () async => false,
      requestReview: () async => requests++,
    );
    expect(await launcher.request(), StoreReviewRequestResult.unavailable);
    expect(requests, 0);
  });

  test('a platform error is reported as unavailable, never thrown', () async {
    final launcher = InAppReviewLauncher(
      isAvailable: () async => true,
      requestReview: () async => throw StateError('play services missing'),
    );
    expect(await launcher.request(), StoreReviewRequestResult.unavailable);
  });
}
