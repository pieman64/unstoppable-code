import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_read_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

// The production transport. IOClient attaches the abort trigger only after
// HttpClient.openUrl returns, so a connection still in its TCP connect or
// TLS handshake cannot be aborted per request. This listener accepts TCP
// and answers the TLS handshake only when a test completes it.
//
// Registers the cases through [testCase], so the unit suite and the Android
// device target (`integration_test/can_4873_read_transport_device_test.dart`)
// run the same checks on the platform's real sockets. [serverContext] holds a
// throwaway certificate for the loopback HTTPS servers; the clients accept it
// only through their test callback.
void defaultReadTransportCases(
  void Function(String description, Future<void> Function() body) testCase, {
  required Future<SecurityContext> Function() serverContext,
}) {
  late ServerSocket stalling;
  late List<Socket> handshakes;
  late HttpServer healthy;
  late SecurityContext tlsContext;

  setUpAll(() async => tlsContext = await serverContext());

  setUp(() async {
    handshakes = [];
    stalling = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    stalling.listen(handshakes.add);
    healthy = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    healthy.listen((request) {
      request.response.write('ok');
      unawaited(request.response.close());
    });
  });

  tearDown(() async {
    for (final socket in handshakes) {
      socket.destroy();
    }
    await stalling.close();
    await healthy.close(force: true);
  });

  Future<String> readStalled(PortalReadClient reads, Duration timeout) =>
      reads.run(
        timeout,
        (client) =>
            client.read(Uri.parse('https://127.0.0.1:${stalling.port}/state')),
      );

  Future<String> readHealthy(PortalReadClient reads) => reads.run(
    const Duration(seconds: 5),
    (client) => client.read(Uri.parse('http://127.0.0.1:${healthy.port}/')),
  );

  Future<void> until(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    while (!condition() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(condition(), isTrue);
  }

  testCase('a stalled connection attempt is cancelled at the connect bound '
      'and the pool keeps its connection', () async {
    final reads = PortalReadClient(
      connectTimeout: const Duration(milliseconds: 200),
    );
    addTearDown(reads.reset);
    expect(await readHealthy(reads), 'ok');

    // The transport gives up the attempt itself, before the read deadline.
    await expectLater(
      readStalled(reads, const Duration(seconds: 5)),
      throwsA(
        isA<SocketException>().having(
          (e) => e.message,
          'message',
          contains('HTTP connection timed out'),
        ),
      ),
    );
    expect(handshakes, hasLength(1));

    expect(await readHealthy(reads), 'ok');
    expect(healthy.connectionsInfo().total, 1);
  });

  // HttpClient stops tracking an attempt it gave up at the connect bound,
  // so a handshake that completes after that must still be closed.
  testCase('a TLS connection that completes after the connect bound is closed '
      'and sibling reads keep one TLS connection', () async {
    final siblings = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      tlsContext,
    );
    addTearDown(() => siblings.close(force: true));
    siblings.listen((request) {
      request.response.write('ok');
      unawaited(request.response.close());
    });
    final reads = PortalReadClient(
      connectTimeout: const Duration(milliseconds: 200),
      onBadCertificate: (_) => true,
    );
    addTearDown(reads.reset);
    Future<String> readSibling() => reads.run(
      const Duration(seconds: 5),
      (client) => client.read(Uri.parse('https://127.0.0.1:${siblings.port}/')),
    );
    expect(await readSibling(), 'ok');

    final attempt = readStalled(reads, const Duration(seconds: 5));
    await until(() => handshakes.isNotEmpty);
    expect(await readSibling(), 'ok');
    await expectLater(attempt, throwsA(isA<SocketException>()));

    final completed = await SecureSocket.secureServer(
      handshakes.removeLast(),
      tlsContext,
    );
    addTearDown(completed.destroy);
    // The server sees the client close the connection.
    await completed
        .drain<void>()
        .catchError((Object _) {})
        .timeout(const Duration(seconds: 2));

    expect(await readSibling(), 'ok');
    expect(siblings.connectionsInfo().total, 1);
  });

  // The session read retries transient failures, and an abort is one. A
  // retry after the read has given up must not reach the network: IOClient
  // opens its connection before it sees the completed abort trigger.
  for (final reset in [false, true]) {
    testCase('a retrying session read sends nothing after its '
        '${reset ? 'reset' : 'deadline'}', () async {
      final reads = PortalReadClient();
      addTearDown(reads.reset);
      expect(await readHealthy(reads), 'ok');
      final service = RemoteControlApiService(
        apiClient: ApiClient(baseUrl: 'http://127.0.0.1:${stalling.port}'),
      );
      final session = reads.run(
        Duration(seconds: reset ? 30 : 1),
        (client) => service.fetchCurrentSession(
          httpClient: client,
          retryTransient: true,
        ),
      );
      await until(() => handshakes.isNotEmpty);
      expect(await readHealthy(reads), 'ok');

      if (reset) reads.reset();
      await expectLater(
        session,
        throwsA(
          reset ? isA<http.RequestAbortedException>() : isA<TimeoutException>(),
        ),
      );
      // Past both retry delays (250 and 500 ms).
      await Future<void>.delayed(const Duration(seconds: 1));
      expect(handshakes, hasLength(1));

      expect(await readHealthy(reads), 'ok');
      if (!reset) expect(healthy.connectionsInfo().total, 1);
    });
  }

  testCase('reset settles a read that is still connecting and closes the '
      'pool', () async {
    final reads = PortalReadClient();
    expect(await readHealthy(reads), 'ok');
    expect(healthy.connectionsInfo().total, 1);
    final inFlight = readStalled(reads, const Duration(seconds: 30));
    await until(() => handshakes.isNotEmpty);

    reads.reset();
    await expectLater(
      inFlight.timeout(const Duration(seconds: 2)),
      throwsA(isA<http.RequestAbortedException>()),
    );
    // The retired pool released its kept-alive connection.
    await until(() => healthy.connectionsInfo().total == 0);
  });
}
