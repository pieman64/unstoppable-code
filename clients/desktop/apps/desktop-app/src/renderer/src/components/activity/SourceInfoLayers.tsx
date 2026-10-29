import type { JSX, ReactNode } from 'react';
import {
  getSourceLayerStatusColor,
  getSourceLayerStatusLabel,
} from './source-info-layer-helpers';

/**
 * The shared shape that hook and script source-info layers expose. Both
 * `HookSourceLayer` and `ScriptSourceLayer` (in `@canopy/desktop-shared/types`) satisfy this
 * — but they carry different payloads (`actions` for hooks, `command` for
 * scripts), which is why callers pass a custom `renderBody`.
 */
type SourceInfoLayerStatus = 'active' | 'overridden' | 'disabled' | 'absent';

export interface SourceInfoLayer {
  sourceKey: string;
  sourceLabel: string;
  status: SourceInfoLayerStatus;
}

interface SourceInfoLayersProps<L extends SourceInfoLayer> {
  /** Layers to render in priority order (highest first). */
  layers: ReadonlyArray<L>;
  /** "active" status that highlights the row in emerald. Default `'active'`. */
  activeStatus?: SourceInfoLayerStatus;
  /** Renders the body of each layer (e.g. `<pre>` for scripts, action list
   * for hooks). Returns `null` to omit. */
  renderBody: (layer: L) => ReactNode;
  /** Text shown when `layers` is empty. Preserves the original "No sources
   * detected for this hook." / "No sources detected for this script." copy. */
  emptyText: string;
  /** Optional priority caption. Defaults to "Resolution priority (highest
   * first):" matching both call sites. */
  priorityLabel?: string;
}

/**
 * Source-info layer list rendered inside the script and hook source-info
 * modals. Both modals previously inlined the same priority caption + per-layer
 * card markup with only the body (script command vs. hook actions) differing —
 * `renderBody` lets each caller plug in its custom payload while the shared
 * styling (emerald active border, status badge, ordering, empty text) stays
 * in one place.
 */
export function SourceInfoLayers<L extends SourceInfoLayer>({
  layers,
  activeStatus = 'active',
  renderBody,
  emptyText,
  priorityLabel = 'Resolution priority (highest first):',
}: SourceInfoLayersProps<L>): JSX.Element {
  return (
    <div className="space-y-2">
      <p className="mb-3 text-xs fg-secondary">{priorityLabel}</p>
      {layers.map((layer, index) => (
        <div
          key={layer.sourceKey}
          className={`rounded-lg border p-3 text-xs ${
            layer.status === activeStatus
              ? 'border-line-positive bg-success/[0.06]'
              : 'bg-fg-primary/[0.02]'
          }`}
        >
          <div className="flex items-center justify-between">
            <span
              className={`font-medium ${
                layer.status === activeStatus
                  ? 'fg-success-strong'
                  : 'fg-primary/80'
              }`}
            >
              <span className="mr-1.5 fg-secondary/60">{index + 1}.</span>
              {layer.sourceLabel}
            </span>
            <span
              className={`text-3xs font-medium ${getSourceLayerStatusColor(layer.status)}`}
            >
              {getSourceLayerStatusLabel(layer.status)}
            </span>
          </div>
          {renderBody(layer)}
        </div>
      ))}
      {layers.length === 0 && (
        <p className="py-2 text-xs fg-secondary">{emptyText}</p>
      )}
    </div>
  );
}
