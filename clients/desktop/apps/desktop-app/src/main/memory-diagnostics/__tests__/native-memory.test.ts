import { summarizeMemoryInfraTrace } from '../native-memory';

function bytes(value: number): { type: string; units: string; value: string } {
  return { type: 'scalar', units: 'bytes', value: value.toString(16) };
}

function dumpEvent(
  pid: number,
  id: string,
  dumps: Record<string, unknown>,
): Record<string, unknown> {
  return { ph: 'v', name: 'periodic_interval', pid, id, args: { dumps } };
}

describe('summarizeMemoryInfraTrace', () => {
  it('merges one dump per process and keeps only code-defined allocator names', () => {
    const trace = {
      traceEvents: [
        { ph: 'M', pid: 7, name: 'process_name', args: { name: 'Renderer' } },
        dumpEvent(7, '0x0', {
          process_totals: { private_footprint_bytes: (5000).toString(16) },
        }),
        dumpEvent(7, '0x0', {
          level_of_detail: 'detailed',
          allocators: {
            partition_alloc: {
              attrs: { size: bytes(300), effective_size: bytes(250) },
            },
            'partition_alloc/partitions/buffer': {
              attrs: { size: bytes(200) },
            },
            'blink_gc/main/heap': {
              attrs: { size: bytes(90), effective_size: bytes(90) },
            },
            'cc/tile_manager_0': { attrs: { size: bytes(10) } },
            'v8/isolate_0x12c00488000': { attrs: { size: bytes(10) } },
            'canvas/ResourceProvider_0x13400B09A00': {
              attrs: { size: bytes(10) },
            },
            'malloc/allocated_objects/__180c092002f68a61': {
              attrs: { size: bytes(10) },
            },
            'malloc/partitions/allocator/extra': { attrs: { size: bytes(10) } },
            'global/abc': { attrs: { size: bytes(10) } },
            v8: { attrs: {} },
            skia: { attrs: { size: { units: 'objects', value: '10' } } },
          },
        }),
        // A later dump of the same process is ignored.
        dumpEvent(7, '0x1', {
          process_totals: { private_footprint_bytes: (9999).toString(16) },
          allocators: { malloc: { attrs: { size: bytes(1) } } },
        }),
        dumpEvent(9, '0x0', {
          allocators: { malloc: { attrs: { size: bytes(40) } } },
        }),
      ],
    };

    expect(summarizeMemoryInfraTrace(trace)).toEqual([
      {
        pid: 7,
        privateFootprintBytes: 5000,
        allocators: {
          partition_alloc: { sizeBytes: 300, effectiveSizeBytes: 250 },
          'partition_alloc/partitions/buffer': {
            sizeBytes: 200,
            effectiveSizeBytes: null,
          },
          'blink_gc/main/heap': { sizeBytes: 90, effectiveSizeBytes: 90 },
        },
      },
      {
        pid: 9,
        privateFootprintBytes: null,
        allocators: { malloc: { sizeBytes: 40, effectiveSizeBytes: null } },
      },
    ]);
  });

  it('accepts a bare event array and skips malformed events', () => {
    expect(
      summarizeMemoryInfraTrace([
        null,
        { ph: 'v', pid: '7', id: '0x0', args: { dumps: {} } },
        { ph: 'v', pid: 7, id: '0x0', args: {} },
        dumpEvent(8, '0x0', {
          process_totals: { private_footprint_bytes: 'not hex' },
          allocators: { malloc: 'nope', v8: { attrs: { size: bytes(3) } } },
        }),
      ]),
    ).toEqual([
      {
        pid: 8,
        privateFootprintBytes: null,
        allocators: { v8: { sizeBytes: 3, effectiveSizeBytes: null } },
      },
    ]);
  });

  it('rejects a trace without events', () => {
    expect(() => summarizeMemoryInfraTrace({ metadata: {} })).toThrow(
      'The memory trace has no events.',
    );
  });
});
