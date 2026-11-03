// CAN-4873 — the Remote Control read transport on a device. Make a throwaway
// certificate outside the checkout, then run from apps/mobile with:
//
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
//     -nodes -keyout <dir>/key.pem -out <dir>/cert.pem -days 1 \
//     -subj /CN=localhost
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4873_read_transport_device_test.dart \
//     --dart-define=LOOPBACK_TLS_CERT=$(base64 < <dir>/cert.pem | tr -d '\n') \
//     --dart-define=LOOPBACK_TLS_KEY=$(base64 < <dir>/key.pem | tr -d '\n') \
//     -d <device-id>
//
// Runs the unit suite's default-transport cases on the device's own sockets:
// the default `PortalReadClient` (IOClient, HttpClient and its connection
// factory) against loopback servers in the app process. Covers TLS
// keep-alive reuse, the connect bound on a stalled TLS handshake, closing a
// handshake that completes after that bound, no retry traffic after a read
// deadline or reset, and reset of a connecting read. Only these test clients
// accept the certificate. No desktop, Portal server or external network.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/default_read_transport_cases.dart';

const _certificate = String.fromEnvironment('LOOPBACK_TLS_CERT');
const _privateKey = String.fromEnvironment('LOOPBACK_TLS_KEY');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  defaultReadTransportCases(
    (description, body) => testWidgets(description, (_) => body()),
    serverContext: () async {
      expect(
        _certificate.isNotEmpty && _privateKey.isNotEmpty,
        isTrue,
        reason: 'Pass the certificate defines shown above.',
      );
      return SecurityContext()
        ..useCertificateChainBytes(base64.decode(_certificate))
        ..usePrivateKeyBytes(base64.decode(_privateKey));
    },
  );
}
