import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../replay-privacy';

describe('replay privacy markers', () => {
  it('pins the block class value the recorder reads', () => {
    expect(REPLAY_BLOCK_CLASS).toBe('ph-no-capture');
  });

  it('pins the mask class value the recorder reads', () => {
    expect(REPLAY_MASK_CLASS).toBe('ph-mask');
  });
});
