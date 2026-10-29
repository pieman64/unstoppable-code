# Output contract

If the host supplies a structured output schema, return exactly that schema. Do not add prose outside the structured response and do not create report artifacts unless the host explicitly requests them.

For each validated finding, include the host's equivalent of:

- concise title with severity;
- changed file and smallest useful line range;
- vulnerable behavior and attacker prerequisites;
- source-to-sink evidence, including why existing controls fail;
- concrete security impact;
- focused remediation direction;
- confidence or uncertainty when the schema permits it.

If no host schema is supplied, return Markdown findings ordered by severity, followed by a compact coverage summary. For no findings, state that no validated security vulnerabilities were found in the reviewed diff and summarize the scope reviewed. Do not claim the code is secure in absolute terms.
