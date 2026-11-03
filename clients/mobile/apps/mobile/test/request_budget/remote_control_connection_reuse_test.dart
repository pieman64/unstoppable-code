// Real TLS connection reuse for Remote Control reads and long-polls
// (CAN-4873). A loopback HTTPS server with keep-alive counts the secure
// connections it accepts; each one costs a TCP and TLS handshake. The
// production repository and event stream use real IOClients that trust only
// this run's throwaway certificate. Local only, like the request budgets:
// `flutter test --tags request-budget`. Needs `openssl` on PATH.
@Tags(['request-budget'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

const _sessionId = 'sess-tls';

final class _TlsServer {
  _TlsServer._(this._server, this._certificate);

  final HttpServer _server;

  /// The only certificate the test clients accept.
  final String _certificate;

  /// The client port of every request, in arrival order. One distinct port is
  /// one accepted connection and one handshake.
  final List<int> connections = [];
  final List<String> routes = [];
  var _polls = 0;

  String get origin => 'https://127.0.0.1:${_server.port}';

  static Future<_TlsServer> start(Directory dir) async {
    final cert = '${dir.path}/cert.pem';
    final key = '${dir.path}/key.pem';
    final result = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    if (result.exitCode != 0) fail('openssl could not create a certificate');
    final serverContext = SecurityContext()
      ..useCertificateChain(cert)
      ..usePrivateKey(key);
    final server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      serverContext,
    );
    final tls = _TlsServer._(server, await File(cert).readAsString());
    server.listen(tls._handle);
    return tls;
  }

  /// A real IOClient that trusts no root and accepts only this run's
  /// certificate. macOS does not apply a context's trusted certificates to a
  /// self-signed leaf, so the pin is checked in the callback instead.
  http.Client client() => IOClient(
    HttpClient(context: SecurityContext(withTrustedRoots: false))
      ..badCertificateCallback = (certificate, host, port) =>
          certificate.pem.trim() == _certificate.trim(),
  );

  void _handle(HttpRequest request) {
    connections.add(request.connectionInfo!.remotePort);
    final path = request.uri.path;
    routes.add(path.split('/').last);
    final response = request.response..headers.contentType = ContentType.json;
    Object body;
    if (path.endsWith('/session')) {
      body = {
        'session': {
          'id': _sessionId,
          'status': 'active',
          'connectionStatus': 'active',
          'clientName': 'TLS Desktop',
        },
      };
    } else if (path.endsWith('/events/stream')) {
      response.statusCode = 404;
      body = {'error': 'Not found'};
    } else if (path.endsWith('/events')) {
      _polls += 1;
      if (_polls > 4) response.statusCode = 403;
      body = {
        'events': <Object>[],
        'nextCursor': _polls,
        'connectionStatus': 'active',
      };
    } else {
      body = {
        'state': {
          'workspaces': <Object>[],
          'worktrees': <Object>[],
          'standaloneChats': <Object>[],
          'chatMessages': <Object>[],
        },
        'connectionStatus': 'active',
        'refreshing': false,
        'eventCursor': 0,
      };
    }
    response.write(jsonEncode(body));
    unawaited(response.close());
  }

  Future<void> close() => _server.close(force: true);
}

void _report(String window, List<int> connections) {
  // ignore: avoid_print
  print(
    'CONNECTION_REUSE ${jsonEncode({'window': window, 'requests': connections.length, 'connections': connections.toSet().length})}',
  );
}

void main() {
  late Directory dir;
  late _TlsServer server;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('can4873-tls-');
    server = await _TlsServer.start(dir);
  });

  tearDown(() async {
    await server.close();
    await dir.delete(recursive: true);
  });

  test(
    'session, overview and chat-cache reads share one TLS connection',
    () async {
      final apiClient = ApiClient(
        baseUrl: server.origin,
        tokenProvider: () => 'token-tls',
        httpClient: server.client(),
      );
      final repository = HttpRemoteControlRepository(
        service: RemoteControlApiService(apiClient: apiClient),
        recoveryClientFactory: server.client,
        eventStream: PortalEventStream(
          baseUrl: '${server.origin}$portalBrowserBasePath',
          headersProvider: apiClient.buildHeaders,
          clientFactory: server.client,
        ),
      );
      addTearDown(repository.clearLocalSession);

      await repository.restoreSession();
      await repository.fetchSnapshot();
      await repository.fetchCachedChatMessages(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        ),
      );
      await repository.refreshSessionMetadata();

      _report('reads', server.connections);
      expect(server.routes, ['session', 'state', 'state', 'session']);
      expect(server.connections.toSet(), hasLength(1));
    },
  );

  test('consecutive long-polls share one TLS connection', () async {
    final batches = await PortalEventStream(
      baseUrl: '${server.origin}$portalBrowserBasePath',
      headersProvider: () => const {'Authorization': 'Bearer token-tls'},
      clientFactory: server.client,
    ).subscribe(sessionId: _sessionId).toList();

    final polls = [
      for (final (index, route) in server.routes.indexed)
        if (route == 'events') server.connections[index],
    ];
    _report('polls', polls);
    expect(batches.last.events.single, isA<RemoteSessionEndedEvent>());
    expect(polls, hasLength(5));
    expect(polls.toSet(), hasLength(1));
  });
}
