import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/portal_sse_parser.dart';

List<String> _describe(Iterable<SseFrame> frames) => [
  for (final frame in frames) '${frame.id}|${frame.event}|${frame.data}',
];

/// Frames and completed-block count from the stateless parser fed the
/// accumulated stream, the reference behavior.
({List<String> frames, int blocks}) _reference(List<String> chunks) {
  final frames = <SseFrame>[];
  var blocks = 0;
  var buffer = '';
  for (final chunk in chunks) {
    final parsed = parsePortalSseFrames(buffer + chunk);
    buffer = parsed.remainder;
    frames.addAll(parsed.frames);
    if (parsed.sawActivity) blocks += 1;
  }
  return (frames: _describe(frames), blocks: blocks);
}

({List<String> frames, int blocks}) _incremental(List<String> chunks) {
  final parser = PortalSseParser();
  final frames = <SseFrame>[];
  var blocks = 0;
  for (final chunk in chunks) {
    final parsed = parser.add(chunk);
    expect(parsed.oversized, isFalse);
    frames.addAll(parsed.frames);
    if (parsed.sawActivity) blocks += 1;
  }
  return (frames: _describe(frames), blocks: blocks);
}

void _expectSame(
  ({List<String> frames, int blocks}) actual,
  ({List<String> frames, int blocks}) expected,
  String reason,
) {
  expect(actual.frames, expected.frames, reason: reason);
  expect(actual.blocks, expected.blocks, reason: reason);
}

List<String> _split(String text, List<int> cuts) {
  final chunks = <String>[];
  var start = 0;
  for (final cut in cuts) {
    chunks.add(text.substring(start, cut));
    start = cut;
  }
  chunks.add(text.substring(start));
  return chunks;
}

/// A stream mixing every line ending, comments, ids, multi-line data, empty
/// blocks, fields without values and multibyte text.
String _corpus(math.Random random) {
  const endings = ['\n', '\r\n', '\r'];
  final buffer = StringBuffer();
  String end() => endings[random.nextInt(endings.length)];
  for (var block = 0; block < 40; block++) {
    switch (random.nextInt(6)) {
      case 0:
        buffer.write(': keepalive${end()}');
      case 1:
        buffer.write('id: $block${end()}');
      case 2:
        buffer.write('event${end()}');
      default:
        break;
    }
    buffer.write('event: ${block.isEven ? 'batch' : 'error'}${end()}');
    for (var line = 0; line <= random.nextInt(3); line++) {
      buffer.write('data:${line.isEven ? ' ' : ''}{"n":$block,"t":"é✓🙂"}');
      buffer.write(end());
    }
    if (random.nextInt(5) == 0) buffer.write('retry: 1000${end()}');
    buffer.write(end());
    if (random.nextInt(8) == 0) buffer.write(end() * 2);
  }
  return buffer.toString();
}

void main() {
  group('PortalSseParser', () {
    test('matches the stateless parser for every chunking', () {
      final random = math.Random(3372);
      for (var round = 0; round < 30; round++) {
        final text = _corpus(random);
        final whole = _reference([text]);
        expect(_incremental([text]).frames, whole.frames);
        // Fixed small chunk sizes split every CRLF pair and line somewhere.
        for (final size in [1, 2, 3, 7, 64]) {
          final chunks = [
            for (var i = 0; i < text.length; i += size)
              text.substring(i, math.min(i + size, text.length)),
          ];
          _expectSame(_incremental(chunks), _reference(chunks), 'size $size');
        }
        final cuts = {
          for (var i = 0; i < 20; i++) random.nextInt(text.length + 1),
        }.toList()..sort();
        final chunks = _split(text, cuts);
        _expectSame(_incremental(chunks), _reference(chunks), 'cuts $cuts');
        expect(_incremental(chunks).frames, whole.frames);
      }
    });

    test('holds a trailing CR until the next chunk', () {
      final parser = PortalSseParser();
      expect(parser.add('event: batch\r').frames, isEmpty);
      final second = parser.add('\ndata: {"ok":true}\r');
      expect(second.frames, isEmpty);
      // A CR that is not followed by LF is a line ending on its own.
      final third = parser.add('\r');
      expect(third.frames, isEmpty);
      final fourth = parser.add('event: next\r\n\r\n');
      expect(_describe(second.frames + third.frames + fourth.frames), [
        'null|batch|{"ok":true}',
        'null|next|',
      ]);
    });

    test('a lone LF and CRLF split at a chunk boundary are one ending', () {
      final parser = PortalSseParser();
      final frames = [
        ...parser.add('data: a\r').frames,
        ...parser.add('\n').frames,
        ...parser.add('\r').frames,
        ...parser.add('\n').frames,
      ];
      expect(_describe(frames), ['null|null|a']);
    });

    test('reports keepalive comments as activity without a frame', () {
      final parser = PortalSseParser();
      final keepalive = parser.add(': keepalive\n\n');
      expect(keepalive.frames, isEmpty);
      expect(keepalive.sawActivity, isTrue);
      final partial = parser.add('data: partial\n');
      expect(partial.sawActivity, isFalse);
      expect(parser.add('').sawActivity, isFalse);
    });

    test('completes many frames from one chunk', () {
      final parser = PortalSseParser();
      final text = [
        for (var i = 0; i < 1000; i++) 'event: batch\ndata: {"n":$i}\n\n',
      ].join();
      final parsed = parser.add(text);
      expect(parsed.frames, hasLength(1000));
      expect(parsed.frames.last.data, '{"n":999}');
    });

    group('pending cap', () {
      test('accepts a frame whose block fills the cap exactly', () {
        // Block plus its first newline may hold max - 1 characters.
        final parser = PortalSseParser(maxPendingChars: 16);
        final parsed = parser.add('data: 01234567\n\n');
        expect(parsed.oversized, isFalse);
        expect(_describe(parsed.frames), ['null|null|01234567']);
      });

      test('rejects a frame one character over the cap', () {
        final parser = PortalSseParser(maxPendingChars: 16);
        final parsed = parser.add('data: 012345678\n\n');
        expect(parsed.oversized, isTrue);
        expect(parsed.frames, isEmpty);
      });

      test('keeps frames completed before the oversized one', () {
        final parser = PortalSseParser(maxPendingChars: 16);
        final parsed = parser.add('data: ok\n\ndata: 0123456789abcdef');
        expect(parsed.oversized, isTrue);
        expect(_describe(parsed.frames), ['null|null|ok']);
      });

      test('counts across chunks and a held CR', () {
        final parser = PortalSseParser(maxPendingChars: 16);
        expect(parser.add('data: 01234').oversized, isFalse);
        expect(parser.add('5678').oversized, isFalse);
        // 15 retained characters plus the held CR reach the cap.
        expect(parser.add('\r').oversized, isTrue);
      });

      test('counts normalized characters, not CRLF pairs or UTF-8', () {
        // 21 raw characters and 22 UTF-8 bytes, but 17 normalized ones.
        final parser = PortalSseParser(maxPendingChars: 18);
        final parsed = parser.add('event: x\r\ndata: é\r\n\r\n');
        expect(parsed.oversized, isFalse);
        expect(_describe(parsed.frames), ['null|x|é']);
      });

      test('resets after each completed block', () {
        final parser = PortalSseParser(maxPendingChars: 16);
        for (var i = 0; i < 100; i++) {
          final parsed = parser.add('data: 01234567\n\n');
          expect(parsed.oversized, isFalse);
          expect(parsed.frames, hasLength(1));
        }
      });

      test('defaults to the transport character cap', () {
        expect(PortalSseParser().maxPendingChars, kMaxPortalSseBufferChars);
        final parser = PortalSseParser();
        final data = 'x' * (kMaxPortalSseBufferChars - 'data: '.length - 2);
        final accepted = parser.add('data: $data\n\n');
        expect(accepted.oversized, isFalse);
        expect(accepted.frames.single.data.length, data.length);
        expect(parser.add('data: x$data\n').oversized, isTrue);
      });
    });
  });
}
