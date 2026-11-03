import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_api_service.dart';

void main() {
  group('classifyCloudSendError', () {
    for (final status in [400, 402, 403, 404]) {
      test('$status is definitive', () {
        expect(
          classifyCloudSendError(status: status, body: {'error': 'x'}).kind,
          CloudSendErrorKind.definitive,
        );
      });
    }

    test('busy 409 is retryable and honors Retry-After', () {
      final error = classifyCloudSendError(
        status: 409,
        body: {
          'error': {
            'code': 'CLOUD_CAPABILITY_DELIVERY_BUSY',
            'message': 'busy',
          },
        },
        headers: {'Retry-After': '2'},
      );
      expect(error.kind, CloudSendErrorKind.retryable);
      expect(error.retryAfter, const Duration(seconds: 2));
      expect(error.code, 'CLOUD_CAPABILITY_DELIVERY_BUSY');
    });

    test('ignores non-finite Retry-After values', () {
      for (final value in ['NaN', 'Infinity', '+Infinity', '-Infinity']) {
        final error = classifyCloudSendError(
          status: 503,
          body: {'error': 'unavailable'},
          headers: {'Retry-After': value},
        );
        expect(
          error.retryAfter,
          const Duration(seconds: 2),
          reason: 'Retry-After: $value should use the status fallback',
        );
      }
    });

    test('ignores Retry-After values that overflow during scaling', () {
      final error = classifyCloudSendError(
        status: 503,
        body: {'error': 'unavailable'},
        headers: {'Retry-After': '1e306'},
      );

      expect(error.retryAfter, const Duration(seconds: 2));
    });

    test('caps finite Retry-After values at one day', () {
      final error = classifyCloudSendError(
        status: 503,
        body: {'error': 'unavailable'},
        headers: {'Retry-After': '1e10'},
      );

      expect(error.retryAfter, const Duration(days: 1));
    });

    test('clamps negative Retry-After values to zero', () {
      final error = classifyCloudSendError(
        status: 503,
        body: {'error': 'unavailable'},
        headers: {'Retry-After': '-1.5'},
      );

      expect(error.retryAfter, Duration.zero);
    });

    test('terminal session 409 is terminalSession', () {
      expect(
        classifyCloudSendError(
          status: 409,
          body: {
            'error': {
              'code': 'terminal_chat_state_changed',
              'message': 'ended',
            },
          },
        ).kind,
        CloudSendErrorKind.terminalSession,
      );
    });

    test('429, 5xx, and transport status 0 are retryable', () {
      for (final status in [429, 500, 502, 503, 0]) {
        expect(
          classifyCloudSendError(status: status, body: null).kind,
          CloudSendErrorKind.retryable,
        );
      }
    });

    test('uses X-Canopy-Error-Code when the body has no code', () {
      final error = classifyCloudSendError(
        status: 503,
        body: {'error': 'unavailable'},
        headers: {'X-Canopy-Error-Code': 'upstream_unavailable'},
      );
      expect(error.code, 'upstream_unavailable');
      expect(error.message, 'unavailable');
    });
  });

  group('out of AI Credits', () {
    const serverMessage = 'Not enough AI credits to continue.';
    const credits = {
      'error': {'code': 'INSUFFICIENT_CREDITS', 'message': serverMessage},
    };

    test('a 402 with INSUFFICIENT_CREDITS uses the app copy', () {
      final error = classifyCloudSendError(status: 402, body: credits);
      expect(error.message, "You're out of AI Credits.");
      expect(error.kind, CloudSendErrorKind.definitive);
      expect(error.code, 'INSUFFICIENT_CREDITS');
    });

    test('a 402 with the code only in the header uses the app copy', () {
      final error = classifyCloudSendError(
        status: 402,
        body: {'error': serverMessage},
        headers: {'X-Canopy-Error-Code': 'INSUFFICIENT_CREDITS'},
      );
      expect(error.message, "You're out of AI Credits.");
    });

    test('other 402 codes and non-402 statuses keep the server message', () {
      expect(
        classifyCloudSendError(
          status: 402,
          body: {
            'error': {'code': 'OTHER_PAYMENT', 'message': serverMessage},
          },
        ).message,
        serverMessage,
      );
      expect(
        classifyCloudSendError(status: 403, body: credits).message,
        serverMessage,
      );
    });

    test('CloudApiException uses the app copy only for a credits 402', () {
      CloudApiException parse(int status, String code) =>
          CloudApiException.fromApiException(
            ApiException(
              statusCode: status,
              body: jsonEncode({
                'error': {'code': code, 'message': serverMessage},
              }),
            ),
          );

      expect(
        parse(402, 'INSUFFICIENT_CREDITS').message,
        "You're out of AI Credits.",
      );
      expect(parse(402, 'OTHER_PAYMENT').message, serverMessage);
      expect(parse(400, 'INSUFFICIENT_CREDITS').message, serverMessage);
    });
  });
}
