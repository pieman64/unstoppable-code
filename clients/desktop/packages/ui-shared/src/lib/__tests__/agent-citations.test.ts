import { stripOpaqueAgentCitationMarkers } from '../agent-citations';

describe('stripOpaqueAgentCitationMarkers', () => {
  it('removes a complete provider citation marker', () => {
    expect(
      stripOpaqueAgentCitationMarkers(
        'Sunny and 78°F. \uE200cite\uE202turn0forecast0\uE201',
      ),
    ).toBe('Sunny and 78°F. ');
  });

  it('removes a marker containing multiple source references', () => {
    expect(
      stripOpaqueAgentCitationMarkers(
        'Answer \uE200cite\uE202turn0search0\uE202turn0search1\uE201 continues.',
      ),
    ).toBe('Answer  continues.');
  });

  it('hides an incomplete marker while text is streaming', () => {
    expect(
      stripOpaqueAgentCitationMarkers('Answer \uE200cite\uE202turn0forecast'),
    ).toBe('Answer ');
  });

  it('leaves ordinary markdown unchanged', () => {
    const markdown = 'See **the answer** and [source](https://example.com).';
    expect(stripOpaqueAgentCitationMarkers(markdown)).toBe(markdown);
  });
});
