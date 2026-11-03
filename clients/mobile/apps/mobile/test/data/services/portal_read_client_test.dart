import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/services/portal_read_client.dart';

import '../../support/default_read_transport_cases.dart';

/// A pooled client double: requests to `/stall` hang before headers and
/// `/body-stall` after headers until aborted, like a dead socket; `/ignore`
/// hangs and ignores the abort, like a connection still being established;
/// `/slow` answers after 50 ms; every other request answers 200.
final class _PoolDouble extends http.BaseClient {
  var closes = 0;
  var aborted = 0;
  final sent = <String>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    sent.add(request.url.path);
    switch (request.url.path) {
      case '/stall':
        final response = Completer<http.StreamedResponse>();
        _onAbort(
          request,
          () => response.completeError(http.RequestAbortedException()),
        );
        return response.future;
      case '/ignore':
        return Completer<http.StreamedResponse>().future;
      case '/slow':
        return Future.delayed(
          const Duration(milliseconds: 50),
          () => http.StreamedResponse(Stream.value([111, 107]), 200),
        );
      case '/body-stall':
        final body = StreamController<List<int>>();
        _onAbort(request, () {
          body.addError(http.RequestAbortedException());
          unawaited(body.close());
        });
        body.add([111]);
        return Future.value(http.StreamedResponse(body.stream, 200));
      default:
        return Future.value(
          http.StreamedResponse(Stream.value([111, 107]), 200),
        );
    }
  }

  void _onAbort(http.BaseRequest request, void Function() abort) {
    if (request case http.Abortable(:final abortTrigger?)) {
      unawaited(
        abortTrigger.whenComplete(() {
          aborted += 1;
          abort();
        }),
      );
    }
  }

  @override
  void close() => closes += 1;
}

void main() {
  late List<_PoolDouble> pools;
  late PortalReadClient reads;

  setUp(() {
    pools = [];
    reads = PortalReadClient(
      clientFactory: () {
        final pool = _PoolDouble();
        pools.add(pool);
        return pool;
      },
    );
  });

  Future<String> read(String path, [Duration? timeout]) => reads.run(
    timeout ?? const Duration(seconds: 5),
    (client) => client.read(Uri.parse('https://portal.test$path')),
  );

  test('consecutive reads share one pool that stays open', () async {
    expect(await read('/session'), 'ok');
    expect(await read('/state'), 'ok');

    expect(pools, hasLength(1));
    expect(pools.single.sent, ['/session', '/state']);
    expect(pools.single.closes, 0);
  });

  test('a read past its deadline is aborted alone', () async {
    final overlapping = read('/state');
    await expectLater(
      read('/stall', const Duration(milliseconds: 20)),
      throwsA(isA<TimeoutException>()),
    );

    expect(await overlapping, 'ok');
    expect(pools.single.aborted, 1);
    expect(pools.single.closes, 0);
    expect(await read('/session'), 'ok');
    expect(pools, hasLength(1));
  });

  test(
    'reset closes an idle pool and the next read opens a fresh one',
    () async {
      await read('/session');
      reads.reset();
      expect(pools.single.closes, 1);

      await read('/session');
      expect(pools, hasLength(2));
      expect(pools.last.closes, 0);
    },
  );

  // A read pending when the pool retires (background, teardown, or a
  // replaced session) must not run on to its deadline or deliver a result.
  for (final path in ['/stall', '/body-stall']) {
    test('reset aborts a read pending on $path', () async {
      final inFlight = read(path, const Duration(seconds: 30));
      await pumpEventQueue();
      reads.reset();

      await expectLater(inFlight, throwsA(isA<http.RequestAbortedException>()));
      expect(pools.single.aborted, 1);
      expect(pools.single.closes, 1);
    });
  }

  test('reset rejects a result that arrives after it', () async {
    final pending = Completer<String>();
    final inFlight = reads.run(
      const Duration(seconds: 5),
      (client) => pending.future,
    );
    await pumpEventQueue();
    reads.reset();
    expect(pools.single.closes, 0);

    pending.complete('late');
    await expectLater(inFlight, throwsA(isA<http.RequestAbortedException>()));
    expect(pools.single.closes, 1);
    reads.reset();
    expect(pools.single.closes, 1);
  });

  test('reset aborts every overlapping read and leaves the next pool '
      'usable', () async {
    final first = read('/stall', const Duration(seconds: 30));
    final second = read('/body-stall', const Duration(seconds: 30));
    await pumpEventQueue();
    reads.reset();
    final fresh = read('/session');

    await expectLater(first, throwsA(isA<http.RequestAbortedException>()));
    await expectLater(second, throwsA(isA<http.RequestAbortedException>()));
    expect(await fresh, 'ok');
    expect(pools, hasLength(2));
    expect(pools.first.aborted, 2);
    expect(pools.first.closes, 1);
    expect(pools.last.closes, 0);
  });

  // A request still establishing its connection ignores the abort trigger.
  test('reset settles a read whose transport ignores the abort', () async {
    final inFlight = reads.run(
      const Duration(seconds: 30),
      (client) => Completer<String>().future,
    );
    reads.reset();

    await expectLater(
      inFlight.timeout(const Duration(seconds: 1)),
      throwsA(isA<http.RequestAbortedException>()),
    );
    expect(pools.single.closes, 1);
  });

  test('closing the borrowed client leaves the pool open', () async {
    await reads.run(const Duration(seconds: 5), (client) async {
      client.close();
      return client.read(Uri.parse('https://portal.test/session'));
    });

    expect(pools.single.closes, 0);
  });

  group('seeded read lifecycles', () {
    // Random interleavings of reads that answer, answer late, stall before
    // headers or in the body, or ignore the abort, with deadlines and resets.
    // Invariants:
    //  * a read with no reset before it settles answers, or times out at its
    //    deadline when it stalls;
    //  * a read pending at a reset fails at once and never answers;
    //  * each retired pool closes exactly once; the current one stays open.
    const paths = ['/ok', '/slow', '/stall', '/body-stall', '/ignore'];
    const deadlines = [20, 100, 1000];
    for (var seed = 0; seed < 40; seed++) {
      test('seed $seed', () {
        fakeAsync((async) {
          final random = math.Random(seed);
          final resets = <Duration>[];
          final violations = <String>[];
          final settled = <Future<void>>[];
          _PoolDouble? current;

          void start() {
            final path = paths[random.nextInt(paths.length)];
            final deadline = Duration(
              milliseconds: deadlines[random.nextInt(deadlines.length)],
            );
            final startedAt = async.elapsed;
            final resetsBefore = resets.length;
            final label = '$path/${deadline.inMilliseconds}ms@$startedAt';

            void check(Object outcome) {
              final reset = resets.length > resetsBefore
                  ? resets[resetsBefore]
                  : null;
              final answers =
                  path == '/ok' ||
                  (path == '/slow' && deadline.inMilliseconds > 50);
              final expected = reset != null
                  ? 'abort'
                  : answers
                  ? 'answer'
                  : 'timeout';
              final at =
                  reset ?? startedAt + (answers ? Duration.zero : deadline);
              final matches = switch (expected) {
                'abort' => outcome is http.RequestAbortedException,
                'answer' => outcome == 'ok',
                _ => outcome is TimeoutException,
              };
              if (!matches) {
                violations.add('$label settled with $outcome, not $expected');
              }
              if (expected != 'answer' && async.elapsed != at) {
                violations.add('$label settled at ${async.elapsed}, not $at');
              }
            }

            settled.add(
              read(path, deadline).then(check, onError: (Object e) => check(e)),
            );
            current = pools.last;
          }

          for (var step = 0; step < 30; step++) {
            switch (random.nextInt(3)) {
              case 0:
                start();
              case 1:
                resets.add(async.elapsed);
                reads.reset();
                current = null;
              default:
                async.elapse(Duration(milliseconds: random.nextInt(120)));
            }
            async.flushMicrotasks();
          }
          async.elapse(const Duration(seconds: 2));

          var done = 0;
          for (final future in settled) {
            unawaited(future.then((_) => done += 1));
          }
          async.flushMicrotasks();
          expect(done, settled.length, reason: 'seed $seed: unsettled reads');
          expect(violations, isEmpty, reason: 'seed $seed');
          for (final pool in pools) {
            expect(
              pool.closes,
              identical(pool, current) ? 0 : 1,
              reason: 'seed $seed',
            );
          }
        });
      });
    }
  });

  group('on the default transport', () {
    defaultReadTransportCases(test, serverContext: _throwawayServerContext);
  });
}

/// A self-signed certificate for the loopback HTTPS servers, made per run so
/// no private key is checked in.
Future<SecurityContext> _throwawayServerContext() async {
  final dir = await Directory.systemTemp.createTemp('portal_read_tls');
  addTearDown(() => dir.delete(recursive: true));
  final cert = '${dir.path}/cert.pem';
  final key = '${dir.path}/key.pem';
  final result = await Process.run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
  ]);
  expect(result.exitCode, 0, reason: 'openssl creates a certificate');
  return SecurityContext()
    ..useCertificateChain(cert)
    ..usePrivateKey(key);
}
