import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_file_client.dart';
import 'package:mobile/data/services/portal_read_client.dart';

const request = RemoteFileRequest(
  projectId: 'ws',
  worktreeId: 'wt',
  fileRootLocalId: 'root',
  relativePath: '.playwright/can-5128/report.md',
);
const capabilities = {'chat_assets_v1': true};
http.Response json(Object? value, [int status = 200]) =>
    http.Response(jsonEncode(value), status);

Map<String, Object?> chunk(
  List<int> bytes, {
  int offset = 0,
  int? size,
  int? nextOffset,
  String version = 'v1',
}) => {
  'assetId': 'file-root-report',
  'filename': 'report.png',
  'mediaType': 'image/png',
  'size': size ?? bytes.length,
  'version': version,
  'offset': offset,
  'dataBase64': base64Encode(bytes),
  'contentSha256': sha256.convert(bytes).toString(),
  'nextOffset': nextOffset,
};

Matcher failure(RemoteFileFailure kind) =>
    isA<RemoteFileException>().having((e) => e.failure, 'failure', kind);

void main() {
  late PortalReadClient reads;
  PortalFileClient build(
    Future<http.Response> Function(http.Request) handler, {
    Duration timeout = const Duration(seconds: 3),
    DateTime Function()? now,
    Future<void> Function(Duration)? delay,
  }) {
    reads = PortalReadClient(clientFactory: () => MockClient(handler));
    return PortalFileClient(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        tokenProvider: () => 'token',
        twoFactorProofProvider: () => 'proof',
      ),
      reads: reads,
      timeout: timeout,
      now: now,
      delay: delay,
    );
  }

  tearDown(() => reads.reset());

  test(
    'text read posts canonical payload and preserves flags and empty text',
    () async {
      final client = build((r) async {
        expect(r.url.path, endsWith('/sessions/session/file/read'));
        expect(r.headers['authorization'], 'Bearer token');
        expect(r.headers['x-two-factor-verified'], 'proof');
        expect(jsonDecode(r.body), request.toJson());
        return json({'content': '', 'truncated': true, 'unsupported': true});
      });
      final result = await client.readFile('session', request);
      expect(result.contents, '');
      expect(result.truncated, isTrue);
      expect(result.unsupported, isTrue);
      expect(
        const RemoteFileRequest(
          projectId: 'ws',
          worktreeId: 'wt',
          repoId: 'repo',
          relativePath: 'a',
        ).toJson(),
        {
          'projectId': 'ws',
          'worktreeId': 'wt',
          'repoId': 'repo',
          'relativePath': 'a',
        },
      );
    },
  );

  test('resolve posts href and preserves unresolved null', () async {
    var count = 0;
    final client = build((r) async {
      expect(r.url.path, endsWith('/file/resolve'));
      expect(jsonDecode(r.body), {
        'projectId': 'ws',
        'worktreeId': 'wt',
        'href': '.playwright/can-5128/report.md',
      });
      return json(
        count++ == 0
            ? {
                'fileRootLocalId': 'root',
                'relativePath': '.playwright/can-5128/report.md',
              }
            : null,
      );
    });
    Future<RemoteFileLink?> resolve() => client.resolveLink(
      'session',
      projectId: 'ws',
      worktreeId: 'wt',
      href: request.relativePath,
    );
    expect((await resolve())?.relativePath, request.relativePath);
    expect(await resolve(), isNull);
  });

  test(
    'assembles chunks, pins version, acknowledges verified results',
    () async {
      final calls = <http.Request>[];
      final client = build((r) async {
        calls.add(r);
        if (r.method == 'DELETE') return http.Response('', 204);
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        expect(body['type'], 'portal.file.asset.read');
        expect(body['target'], {
          'workspaceLocalId': 'ws',
          'worktreeLocalId': 'wt',
        });
        if (calls.length == 1) {
          expect(body['payload'], {...request.toJson(), 'offset': 0});
          return json({
            'commandId': 'c1',
            'result': chunk([1, 2], size: 4, nextOffset: 2),
          });
        }
        expect(body['payload'], {
          ...request.toJson(),
          'offset': 2,
          'version': 'v1',
        });
        expect(r.headers['X-Portal-Asset-Acknowledgement'], 'c1');
        return json({
          'commandId': 'c2',
          'result': chunk([3, 4], size: 4, offset: 2),
        });
      });
      final result = await client.readAsset(
        'session',
        request,
        capabilities: capabilities,
      );
      expect(result.bytes, [1, 2, 3, 4]);
      expect(result.filename, 'report.png');
      expect(result.mediaType, 'image/png');
      expect(result.version, 'v1');
      expect(calls.last.url.path, endsWith('/commands/c2'));
    },
  );

  test('rejects a version change between chunks', () async {
    var count = 0;
    final client = build(
      (_) async => json({
        'result': count++ == 0
            ? chunk([1], size: 2, nextOffset: 1)
            : chunk([2], size: 2, offset: 1, version: 'v2'),
      }),
    );
    await expectLater(
      client.readAsset('s', request, capabilities: capabilities),
      throwsA(failure(RemoteFileFailure.changed)),
    );
  });

  test('rejects hash mismatch before acknowledging', () async {
    final client = build((r) async {
      expect(r.method, 'POST');
      return json({
        'commandId': 'bad',
        'result': {
          ...chunk([1]),
          'contentSha256': '0' * 64,
        },
      });
    });
    await expectLater(
      client.readAsset('s', request, capabilities: capabilities),
      throwsA(failure(RemoteFileFailure.integrity)),
    );
  });

  test(
    'rejects oversized images before allocating or fetching another chunk',
    () async {
      final client = build(
        (_) async => json({
          'result': chunk([1], size: remoteImageMaxBytes + 1, nextOffset: 1),
        }),
      );
      await expectLater(
        client.readAsset('s', request, capabilities: capabilities),
        throwsA(failure(RemoteFileFailure.tooLarge)),
      );
    },
  );

  test('refuses old desktops before sending a command', () async {
    final client = build((_) async => fail('must not send'));
    await expectLater(
      client.readAsset('s', request, capabilities: {}),
      throwsA(failure(RemoteFileFailure.unsupportedDesktop)),
    );
  });

  for (final (status, message, kind) in [
    (403, 'Asset reads are not allowed.', RemoteFileFailure.permissionDenied),
    (
      400,
      'File is outside the selected worktree root.',
      RemoteFileFailure.outsideRoot,
    ),
    (404, 'File not found.', RemoteFileFailure.notFound),
    (400, 'Binary files cannot be read.', RemoteFileFailure.binaryFile),
    (504, 'Timed out waiting for the file preview.', RemoteFileFailure.timeout),
  ]) {
    test('maps $kind', () async {
      final client = build((_) async => json({'error': message}, status));
      await expectLater(client.readFile('s', request), throwsA(failure(kind)));
    });
  }

  test(
    'maps desktop asset refusal messages on successful HTTP responses',
    () async {
      final client = build(
        (_) async => json({
          'error': 'The paired asset session is no longer authorized.',
        }),
      );
      await expectLater(
        client.readAsset('s', request, capabilities: capabilities),
        throwsA(failure(RemoteFileFailure.permissionDenied)),
      );
    },
  );

  test('rejects binary text even when the server returns content', () async {
    final client = build(
      (_) async => json({'content': 'a\u0000b', 'truncated': false}),
    );
    await expectLater(
      client.readFile('s', request),
      throwsA(failure(RemoteFileFailure.binaryFile)),
    );
  });

  test('transport deadline is typed', () async {
    final pending = Completer<http.Response>();
    final client = build(
      (_) => pending.future,
      timeout: const Duration(milliseconds: 5),
    );
    await expectLater(
      client.readFile('s', request),
      throwsA(failure(RemoteFileFailure.timeout)),
    );
    pending.complete(json({'content': 'late', 'truncated': false}));
  });

  test(
    '429 retries the same chunk and stops after the busy deadline',
    () async {
      var now = DateTime.utc(2026);
      var calls = 0;
      final client = build(
        (r) async {
          calls++;
          expect((jsonDecode(r.body) as Map)['payload'], {
            ...request.toJson(),
            'offset': 0,
          });
          return http.Response('busy', 429);
        },
        now: () => now,
        delay: (d) async {
          now = now.add(d);
        },
      );
      await expectLater(
        client.readAsset('s', request, capabilities: capabilities),
        throwsA(failure(RemoteFileFailure.timeout)),
      );
      expect(calls, 66);
    },
  );

  test(
    '429 recovery follows late result without resubmitting the command',
    () async {
      var now = DateTime.utc(2026);
      var posts = 0;
      var polls = 0;
      final client = build(
        (r) async {
          if (r.method == 'DELETE') return http.Response('', 204);
          if (r.method == 'POST') {
            if (posts++ == 0) return json({}, 429);
            return json({
              'commandId': 'late',
              'errorCode': 'portal_asset_read_pending',
              'error': 'Still waiting.',
            });
          }
          expect(r.url.path, endsWith('/commands/late'));
          return json({
            'commandId': 'late',
            'status': polls++ == 0 ? 'DELIVERED' : 'COMPLETED',
            if (polls > 1) 'result': chunk([9, 8, 7]),
          });
        },
        now: () => now,
        delay: (d) async {
          now = now.add(d);
        },
      );
      expect(
        (await client.readAsset(
          's',
          request,
          capabilities: capabilities,
        )).bytes,
        [9, 8, 7],
      );
      expect(posts, 2);
      expect(polls, 2);
    },
  );

  test('late result deadline is typed', () async {
    var now = DateTime.utc(2026);
    final client = build(
      (r) async => json(
        r.method == 'POST'
            ? {
                'commandId': 'late',
                'errorCode': 'portal_asset_read_pending',
                'error': 'Waiting.',
              }
            : {'commandId': 'late', 'status': 'QUEUED'},
      ),
      now: () => now,
      delay: (d) async {
        now = now.add(d);
      },
    );
    await expectLater(
      client.readAsset('s', request, capabilities: capabilities),
      throwsA(failure(RemoteFileFailure.timeout)),
    );
  });

  for (final mutation in <Map<String, Object?>>[
    {'offset': 1},
    {'nextOffset': 0},
    {'nextOffset': 2},
    {'dataBase64': '%%%='},
    {'filename': '../image.png'},
    {'contentSha256': 'bad'},
    {'size': -1},
  ]) {
    test('rejects malformed chunk $mutation', () async {
      final client = build(
        (_) async => json({
          'result': {
            ...chunk([1]),
            ...mutation,
          },
        }),
      );
      await expectLater(
        client.readAsset('s', request, capabilities: capabilities),
        throwsA(failure(RemoteFileFailure.invalidResponse)),
      );
    });
  }

  test(
    'limits simultaneous transfers to three and admits the next read',
    () async {
      final pending = <Completer<http.Response>>[];
      final client = build((_) {
        final response = Completer<http.Response>();
        pending.add(response);
        return response.future;
      });
      final results = [
        for (var i = 0; i < 4; i++)
          client.readAsset('s', request, capabilities: capabilities),
      ];
      await Future<void>.delayed(Duration.zero);
      expect(pending.length, 3);
      pending.first.complete(
        json({
          'result': chunk([1]),
        }),
      );
      await results.first;
      await Future<void>.delayed(Duration.zero);
      expect(pending.length, 4);
      for (final response in pending.skip(1)) {
        response.complete(
          json({
            'result': chunk([1]),
          }),
        );
      }
      expect(await Future.wait(results), hasLength(4));
    },
  );

  test('reset cancels queued transfers before they can send', () async {
    final pending = <Completer<http.Response>>[];
    final client = build((_) {
      final response = Completer<http.Response>();
      pending.add(response);
      return response.future;
    });
    final assertions = [
      for (var i = 0; i < 4; i++)
        expectLater(
          client.readAsset('s', request, capabilities: capabilities),
          throwsA(failure(RemoteFileFailure.unavailable)),
        ),
    ];
    await Future<void>.delayed(Duration.zero);
    expect(pending.length, 3);
    reads.reset();
    await Future.wait(assertions);
    for (final response in pending) {
      response.complete(
        json({
          'result': chunk([1]),
        }),
      );
    }
    await Future<void>.delayed(Duration.zero);
    expect(pending.length, 3);
  });

  test(
    'pool reset cancels retry and prevents subsequent network reads',
    () async {
      final retry = Completer<void>();
      final started = Completer<void>();
      var calls = 0;
      final client = build(
        (_) async {
          calls++;
          return json({}, 429);
        },
        delay: (_) {
          started.complete();
          return retry.future;
        },
      );
      final result = client.readAsset('s', request, capabilities: capabilities);
      final assertion = expectLater(
        result,
        throwsA(failure(RemoteFileFailure.unavailable)),
      );
      await started.future;
      reads.reset();
      await assertion;
      retry.complete();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1);
    },
  );
}
