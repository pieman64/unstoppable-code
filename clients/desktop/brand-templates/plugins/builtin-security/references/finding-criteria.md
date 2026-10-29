# Finding criteria

Report a finding only when all of these are true:

1. The vulnerable behavior is introduced, exposed, or materially worsened by the reviewed diff.
2. A realistic attacker or lower-privileged actor can reach the source under the repository's actual trust model.
3. The data or control flow reaches a security-sensitive sink or decision.
4. Existing controls do not prevent the path.
5. The consequence affects confidentiality, integrity, availability, authentication, authorization, isolation, or another stated security property.
6. The report identifies a concrete changed location and enough evidence for another engineer to reproduce the reasoning.

Do not report:

- speculative concerns without a source-to-impact path;
- style, maintainability, correctness, or reliability issues with no security consequence;
- missing defense-in-depth when the primary control is effective;
- pre-existing vulnerabilities unaffected by the diff, though they may be mentioned briefly as out-of-scope context when essential;
- findings that depend on implausible deployment assumptions contradicted by repository evidence;
- duplicates that share the same root cause and remediation.

Prefer a smaller set of high-confidence findings over a long candidate list.
