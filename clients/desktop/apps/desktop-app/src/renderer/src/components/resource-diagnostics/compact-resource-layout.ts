export const RESOURCE_TEXT_MIN_FORWARD_GAP_PX = 8;
export type CompactResourceLayout = 'full' | 'memory' | 'icon';

export interface CompactResourceTextMeasurement {
  buttonRight: number;
  forwardRight: number;
  paddingRight: number;
  iconWidth: number;
  controlGap: number;
  cpuSegmentWidth: number;
  memoryWidth: number;
}

export function selectCompactResourceLayout({
  buttonRight,
  forwardRight,
  paddingRight,
  iconWidth,
  controlGap,
  cpuSegmentWidth,
  memoryWidth,
}: CompactResourceTextMeasurement): CompactResourceLayout {
  const textEnd = buttonRight - paddingRight - iconWidth - controlGap;
  const fullTextStart = textEnd - cpuSegmentWidth - memoryWidth;
  if (fullTextStart - forwardRight >= RESOURCE_TEXT_MIN_FORWARD_GAP_PX) {
    return 'full';
  }

  const memoryTextStart = textEnd - memoryWidth;
  if (memoryTextStart - forwardRight >= RESOURCE_TEXT_MIN_FORWARD_GAP_PX) {
    return 'memory';
  }

  return 'icon';
}
