# Legacy share fixtures

Wire payloads exactly as a share looked before a format change. Each file is
dated with the last day that shape was the only one published.

**Never regenerate or edit these files.** They stand in for shares already
published in production, which nobody can re-publish. A test that fails
against one means a live share just stopped installing. Fix the reader, not
the fixture. When a format changes again, add a new dated file beside the old
one.

This is the compatibility contract in the capability-package plan (tracked on
CAN-3310): every surface keeps a pinned fixture from before its change, and it
must install after every later change.

| File                                        | Shape                                                                                                                    | Readers that must accept it                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `skill/public-snapshot.2026-09-22.json`     | `GET /api/v1/<brand>/public-shares/skills/<id>` body before skills carried packages: no `distributionMode`, no `package` | Web public route (served back unchanged), desktop public-share client, desktop share landing and import |
| `skill/shared-skill-detail.2026-09-22.json` | Team/organization `SharedSkillDetail` before skills carried packages                                                     | Desktop Skills tab, Collections, and deep-link import                                                   |
| `agent/public-snapshot.2026-09-22.json`     | Public Agent snapshot before Agents carried packages                                                                     | Desktop public-share client and Agent import                                                            |
| `collection/editable-draft.2026-09-22.json` | Collection authoring state containing a `draft_custom_skill` before Collections carried packages                         | Collection payload builder and import                                                                   |
| `blueprint/document-v1.2026-09-22.json`     | Original Blueprint document without starter prompts or package metadata                                                  | Blueprint validator and desktop import                                                                  |
| `blueprint/document-v2.2026-09-22.json`     | Blueprint v2 document before package metadata                                                                            | Blueprint validator and desktop import                                                                  |
