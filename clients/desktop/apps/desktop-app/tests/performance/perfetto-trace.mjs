/**
 * Track-event slices from a Perfetto protobuf trace, shaped like Chromium JSON
 * trace events (`name`, `dur` in microseconds, `args`), for the summaries that
 * read JSON traces. Electron 45+ `contentTracing.stopRecording` writes only
 * this format.
 *
 * Covers what Chromium's track events use: per-sequence interning (event
 * names, debug annotation names and string values), the incremental clock
 * that `trace_packet_defaults` names, and begin/end slices on each sequence's
 * default track. Begin and end annotations merge into `args`.
 */

const SEQ_INCREMENTAL_STATE_CLEARED = 1;
const TYPE_SLICE_BEGIN = 1;
const TYPE_SLICE_END = 2;

function* protoFields(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= bytes.length) throw new Error('Truncated Perfetto trace');
      const byte = bytes[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
  };
  const take = (length) => {
    if (offset + length > bytes.length)
      throw new Error('Truncated Perfetto trace');
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  while (offset < bytes.length) {
    const key = Number(varint());
    const field = key >> 3;
    const wireType = key & 7;
    if (wireType === 0) yield { field, varint: varint() };
    else if (wireType === 1) yield { field, bytes: take(8) };
    else if (wireType === 2) yield { field, bytes: take(Number(varint())) };
    else if (wireType === 5) yield { field, bytes: take(4) };
    else throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }
}

function groupFields(bytes) {
  const grouped = new Map();
  for (const entry of protoFields(bytes)) {
    const list = grouped.get(entry.field) ?? [];
    list.push(entry);
    grouped.set(entry.field, list);
  }
  return grouped;
}

const text = (bytes) => Buffer.from(bytes).toString('utf8');

function sequenceState() {
  return {
    eventNames: new Map(),
    annotationNames: new Map(),
    stringValues: new Map(),
    clockId: undefined,
    clockUnitNs: 1,
    clockValue: 0,
    open: [],
  };
}

function internEntries(bytes) {
  let iid;
  let value;
  for (const entry of protoFields(bytes)) {
    if (entry.field === 1) iid = entry.varint;
    else if (entry.field === 2) value = text(entry.bytes);
  }
  return [iid, value];
}

function noteInternedData(state, bytes) {
  for (const entry of protoFields(bytes)) {
    // InternedData: event_names = 2, debug_annotation_names = 3,
    // debug_annotation_string_values = 29.
    const table =
      entry.field === 2
        ? state.eventNames
        : entry.field === 3
          ? state.annotationNames
          : entry.field === 29
            ? state.stringValues
            : null;
    if (!table) continue;
    const [iid, value] = internEntries(entry.bytes);
    if (iid !== undefined && value !== undefined) table.set(iid, value);
  }
}

function annotation(state, bytes) {
  let name = '';
  let value;
  const dict = {};
  const array = [];
  let kind = 'value';
  for (const entry of protoFields(bytes)) {
    switch (entry.field) {
      case 1:
        name = state.annotationNames.get(entry.varint) ?? '';
        break;
      case 10:
        name = text(entry.bytes);
        break;
      case 2:
        value = entry.varint !== 0n;
        break;
      case 3:
        value = Number(entry.varint);
        break;
      case 4:
        value = Number(BigInt.asIntN(64, entry.varint));
        break;
      case 5:
        value = Buffer.from(entry.bytes).readDoubleLE(0);
        break;
      case 6:
        value = text(entry.bytes);
        break;
      case 17:
        value = state.stringValues.get(entry.varint);
        break;
      case 9:
        try {
          value = JSON.parse(text(entry.bytes));
        } catch {
          value = text(entry.bytes);
        }
        break;
      case 11: {
        kind = 'dict';
        const [key, nested] = annotation(state, entry.bytes);
        dict[key] = nested;
        break;
      }
      case 12:
        kind = 'array';
        array.push(annotation(state, entry.bytes)[1]);
        break;
      default:
        break;
    }
  }
  return [name, kind === 'dict' ? dict : kind === 'array' ? array : value];
}

function readClockSnapshot(sequences, sequenceId, bytes) {
  for (const clock of protoFields(bytes)) {
    if (clock.field !== 1) continue;
    let id;
    let timestamp = 0;
    let unitNs = 1;
    for (const entry of protoFields(clock.bytes)) {
      if (entry.field === 1) id = Number(entry.varint);
      else if (entry.field === 2) timestamp = Number(entry.varint);
      else if (entry.field === 4) unitNs = Number(entry.varint);
    }
    // Clock ids 64-127 are scoped to the sequence that defines them.
    if (id === undefined || id < 64) continue;
    const state = sequences.get(sequenceId) ?? sequenceState();
    sequences.set(sequenceId, state);
    if (state.clockId === undefined || state.clockId === id) {
      state.clockId = id;
      state.clockUnitNs = unitNs;
      state.clockValue = timestamp;
    }
  }
}

/** Complete-event slices (`dur` in microseconds) from a Perfetto trace. */
export function perfettoTraceEvents(buffer) {
  const sequences = new Map();
  const events = [];
  for (const packetEntry of protoFields(buffer)) {
    if (packetEntry.field !== 1) continue;
    const packet = groupFields(packetEntry.bytes);
    const sequenceId = packet.get(10)?.[0]?.varint ?? 0n;
    let state = sequences.get(sequenceId);
    const flags = Number(packet.get(13)?.[0]?.varint ?? 0n);
    if (!state || flags & SEQ_INCREMENTAL_STATE_CLEARED) {
      const previous = state;
      state = sequenceState();
      if (previous) {
        state.clockId = previous.clockId;
        state.clockUnitNs = previous.clockUnitNs;
        state.clockValue = previous.clockValue;
      }
      sequences.set(sequenceId, state);
    }
    const defaults = packet.get(59)?.[0];
    if (defaults) {
      for (const entry of protoFields(defaults.bytes)) {
        if (entry.field === 58) state.clockId = Number(entry.varint);
      }
    }
    const snapshot = packet.get(6)?.[0];
    if (snapshot) readClockSnapshot(sequences, sequenceId, snapshot.bytes);
    const interned = packet.get(12)?.[0];
    if (interned) noteInternedData(state, interned.bytes);

    const rawTimestamp = Number(packet.get(8)?.[0]?.varint ?? 0n);
    const packetClock = packet.get(58)?.[0]?.varint;
    const usesSequenceClock =
      packetClock === undefined && state.clockId !== undefined;
    let timestampNs = rawTimestamp;
    if (usesSequenceClock) {
      state.clockValue += rawTimestamp;
      timestampNs = state.clockValue * state.clockUnitNs;
    }

    const trackEvent = packet.get(11)?.[0];
    if (!trackEvent) continue;
    const event = groupFields(trackEvent.bytes);
    const type = Number(event.get(9)?.[0]?.varint ?? 0n);
    const args = {};
    for (const entry of event.get(4) ?? []) {
      const [key, value] = annotation(state, entry.bytes);
      if (key) args[key] = value;
    }
    if (type === TYPE_SLICE_BEGIN) {
      const literal = event.get(23)?.[0];
      const name = literal
        ? text(literal.bytes)
        : state.eventNames.get(event.get(10)?.[0]?.varint);
      state.open.push({ name, timestampNs, args });
    } else if (type === TYPE_SLICE_END) {
      const begin = state.open.pop();
      if (!begin?.name) continue;
      events.push({
        name: begin.name,
        dur: Math.max(0, (timestampNs - begin.timestampNs) / 1_000),
        args: { ...begin.args, ...args },
      });
    }
  }
  return events;
}
