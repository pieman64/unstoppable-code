import {
  orgOutsideRepositoriesText,
  orgOutsideRepositoryTooltipText,
} from '../org-multi-repo-copy';

describe('orgOutsideRepositoriesText (CAN-3546)', (): void => {
  it.each([
    [[], "Some repositories don't belong to Acme."],
    [['web3swift'], "web3swift doesn't belong to Acme."],
    [['side', 'tools'], "side and tools don't belong to Acme."],
    [['a', 'b', 'c'], "a, b, and c don't belong to Acme."],
  ])('names %j', (repositories, sentence): void => {
    expect(orgOutsideRepositoriesText(repositories, 'Acme')).toBe(
      `${sentence} Choose repositories that belong to Acme.`,
    );
  });
});

describe('orgOutsideRepositoryTooltipText (CAN-3546)', (): void => {
  it('explains a repository the organization does not hold', (): void => {
    expect(orgOutsideRepositoryTooltipText('engineering-docs', 'Acme')).toBe(
      "engineering-docs doesn't belong to Acme.",
    );
  });
});
