import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';

import '../../../support/tiny_png.dart';

/// A real, decodable PNG of the requested size, so the downscale path runs
/// against genuine encoded bytes rather than a fabricated header.
Future<Uint8List> pngOfSize(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF3366FF),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return data!.buffer.asUint8List();
}

Future<ui.Image> decode(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  final frame = await codec.getNextFrame();
  codec.dispose();
  return frame.image;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AttachmentThumbnailCache cache;

  setUp(() => cache = AttachmentThumbnailCache());
  tearDown(() => cache.dispose());

  test('retains a decodable image as a thumbnail', () async {
    await cache.retain(
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: tinyPngBytes,
    );

    final thumbnail = cache.thumbnailFor('att-1');
    expect(thumbnail, isNotNull);
    // PNG magic number: the cache re-encodes whatever it decoded.
    expect(thumbnail!.sublist(0, 4), [137, 80, 78, 71]);
  });

  test('downscales past the bound and keeps the aspect ratio', () async {
    final cache = AttachmentThumbnailCache(maxDimension: 64);
    addTearDown(cache.dispose);

    await cache.retain(
      attachmentId: 'wide',
      mediaType: 'image/png',
      bytes: await pngOfSize(400, 200),
    );

    final image = await decode(cache.thumbnailFor('wide')!);
    expect(image.width, 64);
    expect(image.height, 32);
    image.dispose();
  });

  test('leaves an image smaller than the bound alone', () async {
    final cache = AttachmentThumbnailCache(maxDimension: 64);
    addTearDown(cache.dispose);

    await cache.retain(
      attachmentId: 'small',
      mediaType: 'image/png',
      bytes: await pngOfSize(20, 10),
    );

    final image = await decode(cache.thumbnailFor('small')!);
    expect(image.width, 20);
    expect(image.height, 10);
    image.dispose();
  });

  test('ignores a media type that is not an image', () async {
    await cache.retain(
      attachmentId: 'doc',
      mediaType: 'application/pdf',
      bytes: tinyPngBytes,
    );

    expect(cache.thumbnailFor('doc'), isNull);
  });

  test('swallows bytes it cannot decode', () async {
    await cache.retain(
      attachmentId: 'broken',
      mediaType: 'image/png',
      bytes: Uint8List.fromList(const [1, 2, 3, 4, 5]),
    );

    expect(cache.thumbnailFor('broken'), isNull);
  });

  test('keeps every native decode owner in the outer cleanup scope', () {
    // dart:ui does not expose disposal state for ImageDescriptor, so enforce
    // the ownership invariant at the source boundary: resources created by
    // separate awaited calls must both be nullable outer-scope locals and be
    // released by the outer finally block.
    final source = File(
      'lib/ui/core/chat/view_models/attachment_thumbnail_cache.dart',
    ).readAsStringSync();

    expect(source, contains('ui.ImmutableBuffer? buffer;'));
    expect(source, contains('ui.ImageDescriptor? descriptor;'));
    expect(
      RegExp(
        r'finally\s*\{[^}]*descriptor\?\.dispose\(\);[^}]*buffer\?\.dispose\(\);',
        dotAll: true,
      ).hasMatch(source),
      isTrue,
    );
  });

  test('evicts the oldest entry once the cap is reached', () async {
    final cache = AttachmentThumbnailCache(maxEntries: 2);
    addTearDown(cache.dispose);

    for (final id in ['a', 'b', 'c']) {
      await cache.retain(
        attachmentId: id,
        mediaType: 'image/png',
        bytes: tinyPngBytes,
      );
    }

    expect(cache.thumbnailFor('a'), isNull);
    expect(cache.thumbnailFor('b'), isNotNull);
    expect(cache.thumbnailFor('c'), isNotNull);
  });

  test('notifies once a thumbnail lands so a rendered chip rebuilds', () async {
    var notifications = 0;
    cache.addListener(() => notifications++);

    await cache.retain(
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: tinyPngBytes,
    );
    expect(notifications, 1);

    // A second retain for the same id is already satisfied: no redundant
    // decode, no rebuild of every chip on screen.
    await cache.retain(
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: tinyPngBytes,
    );
    expect(notifications, 1);
  });

  test('clear drops every retained thumbnail', () async {
    await cache.retain(
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: tinyPngBytes,
    );
    expect(cache.thumbnailFor('att-1'), isNotNull);

    cache.clear();
    expect(cache.thumbnailFor('att-1'), isNull);
  });

  test('clear invalidates a thumbnail decode already in flight', () async {
    final retain = cache.retain(
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: tinyPngBytes,
    );

    cache.clear();
    await retain;

    expect(cache.thumbnailFor('att-1'), isNull);
  });
}
