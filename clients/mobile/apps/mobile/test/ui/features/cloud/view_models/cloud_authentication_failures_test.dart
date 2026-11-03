import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_authentication_failures.dart';

void main() {
  test('reports typed authentication failures from every cloud transport', () {
    final failures = CloudAuthenticationFailures();
    var notifications = 0;
    failures.addListener(() => notifications++);

    failures
      ..report(const CloudApiException(statusCode: 401, message: 'expired'))
      ..report(
        const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 403,
          message: 'forbidden',
        ),
      )
      ..report(
        const CloudEventStreamException(
          kind: CloudEventStreamErrorKind.authentication,
          statusCode: 401,
        ),
      );

    expect(notifications, 3);
  });

  test('ignores cloud availability and non-authentication failures', () {
    final failures = CloudAuthenticationFailures();
    var notifications = 0;
    failures.addListener(() => notifications++);

    failures
      ..report(const CloudApiException(statusCode: 404, message: 'disabled'))
      ..report(
        const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 402,
          message: 'credits required',
        ),
      )
      ..report(
        const CloudEventStreamException(
          kind: CloudEventStreamErrorKind.cloudUnavailable,
          statusCode: 404,
        ),
      );

    expect(notifications, 0);
  });
}
