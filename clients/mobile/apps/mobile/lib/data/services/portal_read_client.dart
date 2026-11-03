import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// One pooled transport for the Remote Control session and state reads, so
/// consecutive reads reuse a kept-alive connection instead of paying a TCP
/// and TLS handshake each (CAN-4873).
///
/// [run] bounds each read: a read that outlives its deadline is aborted on
/// its own socket and fails with a [TimeoutException], leaving the pool and
/// other reads usable. An abort cannot reach a connection that is still in
/// its TCP connect or TLS handshake, so the default transport also bounds
/// each connection attempt by [connectTimeout] and gives it up there. A
/// dart:io HttpClient can cancel a pending TCP connect but not a TLS
/// handshake, whose socket stays open until the server or the OS closes it.
/// When such a handshake completes later, the transport closes the socket.
///
/// After Android resumes the app, a pooled connection can be dead without
/// being closed (CAN-3557), so the owner calls [reset] when the app
/// backgrounds or the session changes: the reads still in flight fail at
/// once, any result they produce later is rejected, and later reads start a
/// fresh pool. The retired pool closes once its last read settles.
final class PortalReadClient {
  PortalReadClient({
    http.Client Function()? clientFactory,
    Duration connectTimeout = const Duration(seconds: 10),
    // Accepts a certificate that fails verification. Only tests set it, for
    // a self-signed loopback server.
    bool Function(X509Certificate certificate)? onBadCertificate,
  }) : _clientFactory =
           clientFactory ??
           (() => IOClient(
             HttpClient()
               ..connectionTimeout = connectTimeout
               ..connectionFactory = (url, proxyHost, proxyPort) =>
                   _connect(url, proxyHost, proxyPort, onBadCertificate),
           ));

  final http.Client Function() _clientFactory;
  _Pool? _pool;

  /// Runs [request] on the pooled client, aborting it after [timeout].
  Future<T> run<T>(
    Duration timeout,
    Future<T> Function(http.Client client) request,
  ) async {
    final pool = _pool ??= _Pool(_clientFactory());
    final abort = Completer<void>();
    pool.reads.add(abort);
    try {
      final result =
          await Future.any([
            request(_AbortableClient(pool.client, abort)),
            abort.future.then<T>((_) => throw http.RequestAbortedException()),
          ]).timeout(
            timeout,
            onTimeout: () {
              if (!abort.isCompleted) abort.complete();
              throw TimeoutException('Portal read timed out.', timeout);
            },
          );
      // The answer belongs to the state before the reset.
      if (pool.retired) throw http.RequestAbortedException();
      return result;
    } finally {
      pool.reads.remove(abort);
      if (pool.retired && pool.reads.isEmpty) pool.client.close();
    }
  }

  /// Retires the current pool and aborts its reads; the next read opens a
  /// fresh one.
  void reset() {
    final pool = _pool;
    _pool = null;
    if (pool == null) return;
    pool.retired = true;
    if (pool.reads.isEmpty) {
      pool.client.close();
      return;
    }
    for (final abort in pool.reads) {
      if (!abort.isCompleted) abort.complete();
    }
  }
}

/// Opens a connection as HttpClient does by default. HttpClient cancels an
/// attempt at its connection timeout and then ignores its socket, but the
/// cancel cannot stop a TLS handshake already in progress, so a socket that
/// the handshake completes later is destroyed here.
Future<ConnectionTask<Socket>> _connect(
  Uri url,
  String? proxyHost,
  int? proxyPort,
  bool Function(X509Certificate certificate)? onBadCertificate,
) async {
  final task = await (proxyHost != null
      ? Socket.startConnect(proxyHost, proxyPort!)
      : url.isScheme('https')
      ? SecureSocket.startConnect(
          url.host,
          url.port,
          onBadCertificate: onBadCertificate,
        )
      : Socket.startConnect(url.host, url.port));
  return ConnectionTask.fromSocket(task.socket, () {
    task.cancel();
    unawaited(
      task.socket.then((socket) => socket.destroy(), onError: (Object _) {}),
    );
  });
}

final class _Pool {
  _Pool(this.client);

  final http.Client client;

  /// The abort trigger of each read in flight.
  final reads = <Completer<void>>{};
  var retired = false;
}

/// Sends through a borrowed pooled client, making each request abortable by
/// [_abort]. Once the read is aborted, it rejects any further request, such
/// as a retry, before it reaches the pool. Closing it leaves the pool open.
final class _AbortableClient extends http.BaseClient {
  _AbortableClient(this._inner, this._abort);

  final http.Client _inner;
  final Completer<void> _abort;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (_abort.isCompleted) throw http.RequestAbortedException(request.url);
    if (request is! http.Request) return _inner.send(request);
    final abortable =
        http.AbortableRequest(
            request.method,
            request.url,
            abortTrigger: _abort.future,
          )
          ..headers.addAll(request.headers)
          ..followRedirects = request.followRedirects
          ..maxRedirects = request.maxRedirects
          ..persistentConnection = request.persistentConnection;
    if (request.bodyBytes.isNotEmpty) abortable.bodyBytes = request.bodyBytes;
    return _inner.send(abortable);
  }
}
