/// Server-sent event framing for the Portal event channel: the stateless
/// [parsePortalSseFrames] (a port of the web client's parser, still used by
/// the cloud chat stream) and the incremental [PortalSseParser] each Portal
/// SSE connection feeds its decoded chunks into.
library;

/// Maximum decoded characters retained while waiting for an SSE frame
/// separator. Oversized frames fail the connection and recover through the
/// normal bounded reconnect/fallback path instead of growing without limit.
const int kMaxPortalSseBufferChars = 1024 * 1024;

/// One parsed SSE frame (`id:` / `event:` / joined `data:` lines).
class SseFrame {
  const SseFrame({this.id, this.event, required this.data});

  final String? id;
  final String? event;
  final String data;
}

/// Result of [parsePortalSseFrames]: completed frames plus the unconsumed
/// buffer remainder to carry into the next chunk. [sawActivity] is true when
/// at least one complete block was parsed — including comment-only keepalive
/// blocks (`: keepalive`) that yield no frame — proving bytes are flowing
/// end-to-end from the origin.
class SseParseResult {
  const SseParseResult({
    required this.frames,
    required this.remainder,
    required this.sawActivity,
  });

  final List<SseFrame> frames;
  final String remainder;
  final bool sawActivity;
}

/// Parses complete SSE frames from an accumulating [buffer] (CRLF-tolerant).
/// Port of the web client's `parsePortalSseFrames`. Each call scans the whole
/// buffer; a long-lived connection should feed [PortalSseParser] instead.
SseParseResult parsePortalSseFrames(String buffer) {
  final frames = <SseFrame>[];
  // Normalize all SSE-spec line endings (\r\n, lone \r, \n) to \n. Payloads
  // are JSON (raw CR/LF are escaped), so this never corrupts frame data. Keep
  // a trailing CR unconsumed until the next chunk arrives: it may be the first
  // half of a CRLF pair, and converting it early would turn the next chunk's
  // leading LF into a false blank-line frame separator.
  final trailingCarriageReturn = buffer.endsWith('\r');
  final normalizable = trailingCarriageReturn
      ? buffer.substring(0, buffer.length - 1)
      : buffer;
  var rest = normalizable.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (trailingCarriageReturn) rest += '\r';

  var sawActivity = false;
  for (;;) {
    final separator = rest.indexOf('\n\n');
    if (separator == -1) break;
    final block = rest.substring(0, separator);
    rest = rest.substring(separator + 2);
    sawActivity = true;

    final fields = _SseBlockFields();
    for (final line in block.split('\n')) {
      fields.addLine(line);
    }
    final frame = fields.takeFrame();
    if (frame != null) frames.add(frame);
  }

  return SseParseResult(
    frames: frames,
    remainder: rest,
    sawActivity: sawActivity,
  );
}

/// What one [PortalSseParser.add] call completed.
final class PortalSseChunk {
  const PortalSseChunk({
    required this.frames,
    required this.sawActivity,
    required this.oversized,
  });

  /// Frames completed by this chunk, in stream order.
  final List<SseFrame> frames;

  /// At least one block (including a comment-only keepalive) completed.
  final bool sawActivity;

  /// The frame in progress reached [PortalSseParser.maxPendingChars] without
  /// its separator. [frames] still holds the frames completed before it; the
  /// connection must be abandoned, and the parser must not be fed again.
  final bool oversized;
}

/// Incremental SSE parser for one connection, equivalent to feeding the
/// accumulated stream to [parsePortalSseFrames] but linear in the characters
/// received: each [add] scans only its own chunk. Line endings are normalized
/// per chunk, with a trailing CR held until the next chunk shows whether it
/// starts a CRLF pair. Complete lines are parsed once into the pending
/// frame's fields; only the line in progress is retained, as chunk fragments.
final class PortalSseParser {
  PortalSseParser({this.maxPendingChars = kMaxPortalSseBufferChars});

  /// Normalized characters the frame in progress may hold, framing included,
  /// before [add] reports it oversized. A held trailing CR counts as one.
  final int maxPendingChars;

  final _line = <String>[];
  final _fields = _SseBlockFields();
  var _pendingChars = 0;
  var _pendingCarriageReturn = false;
  var _afterNewline = false;

  static const int _lf = 0x0A;
  static const int _cr = 0x0D;

  PortalSseChunk add(String chunk) {
    final frames = <SseFrame>[];
    var sawActivity = false;

    // Returns false once the frame in progress overflows.
    bool newline() {
      if (_afterNewline) {
        // A blank line ends the block.
        sawActivity = true;
        final frame = _fields.takeFrame();
        if (frame != null) frames.add(frame);
        _pendingChars = 0;
        _afterNewline = false;
        return true;
      }
      _fields.addLine(switch (_line.length) {
        0 => '',
        1 => _line.single,
        _ => _line.join(),
      });
      _line.clear();
      _afterNewline = true;
      return ++_pendingChars < maxPendingChars;
    }

    bool append(int start, int end) {
      if (start == end) return true;
      _line.add(chunk.substring(start, end));
      _afterNewline = false;
      _pendingChars += end - start;
      return _pendingChars < maxPendingChars;
    }

    PortalSseChunk result({bool oversized = false}) {
      if (oversized) _release();
      return PortalSseChunk(
        frames: frames,
        sawActivity: sawActivity,
        oversized: oversized,
      );
    }

    var position = 0;
    var end = chunk.length;
    if (end == 0) return result();
    if (_pendingCarriageReturn) {
      // The held CR was a line ending either way; a leading LF completes it.
      _pendingCarriageReturn = false;
      _pendingChars -= 1;
      if (chunk.codeUnitAt(0) == _lf) position = 1;
      if (!newline()) return result(oversized: true);
    }
    final holdsCarriageReturn = chunk.codeUnitAt(end - 1) == _cr;
    if (holdsCarriageReturn && position < end) end -= 1;

    // Track the next LF and CR separately so each is searched once.
    var nextLf = chunk.indexOf('\n', position);
    var nextCr = chunk.indexOf('\r', position);
    while (position < end) {
      final lf = nextLf == -1 || nextLf >= end ? end : nextLf;
      final cr = nextCr == -1 || nextCr >= end ? end : nextCr;
      final lineEnd = lf < cr ? lf : cr;
      if (!append(position, lineEnd)) return result(oversized: true);
      if (lineEnd == end) break;
      position = lineEnd + 1;
      if (lineEnd == cr) {
        if (position < end && chunk.codeUnitAt(position) == _lf) position += 1;
        nextCr = chunk.indexOf('\r', position);
      }
      if (nextLf != -1 && nextLf < position) {
        nextLf = chunk.indexOf('\n', position);
      }
      if (!newline()) return result(oversized: true);
    }

    if (holdsCarriageReturn && end < chunk.length) {
      _pendingCarriageReturn = true;
      if (++_pendingChars >= maxPendingChars) return result(oversized: true);
    }
    return result();
  }

  void _release() {
    _line.clear();
    _fields.takeFrame();
    _pendingChars = 0;
    _pendingCarriageReturn = false;
    _afterNewline = false;
  }
}

/// Accumulates one block's `id` / `event` / `data` fields line by line.
final class _SseBlockFields {
  String? _id;
  String? _event;
  final _data = <String>[];

  void addLine(String line) {
    if (line.isEmpty || line.startsWith(':')) return;
    final colon = line.indexOf(':');
    final field = colon == -1 ? line : line.substring(0, colon);
    if (field != 'id' && field != 'event' && field != 'data') return;
    var valueStart = colon == -1 ? line.length : colon + 1;
    if (valueStart < line.length && line.codeUnitAt(valueStart) == 0x20) {
      valueStart += 1;
    }
    final value = line.substring(valueStart);
    switch (field) {
      case 'id':
        _id = value;
      case 'event':
        _event = value;
      default:
        _data.add(value);
    }
  }

  /// The frame for the fields seen since the last call, or null for a block
  /// without any (a comment-only keepalive).
  SseFrame? takeFrame() {
    final frame = _data.isNotEmpty || _event != null || _id != null
        ? SseFrame(id: _id, event: _event, data: _data.join('\n'))
        : null;
    _id = null;
    _event = null;
    _data.clear();
    return frame;
  }
}
