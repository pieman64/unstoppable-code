/** Display a whole formal proposal as Markdown; retain quotes, code and raw history. */
export function stripProposedPlanEnvelope(text: string): string {
  const value = text.trim();
  const opening = '<proposed_plan>';
  const closing = '</proposed_plan>';
  if (
    value.slice(0, opening.length).toLowerCase() !== opening ||
    value.slice(-closing.length).toLowerCase() !== closing
  ) {
    return text;
  }
  return value.slice(opening.length, -closing.length).trim() || text;
}
