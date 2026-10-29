---
name: pr-template
description: >-
  Pull request formatting guidelines. Apply when creating PRs (gh pr create),
  updating PR descriptions, or drafting PR content. Enforces consistent structure
  with title format, sections, and conventional commit tags.
user-invocable: false
---

# PR Template Guidelines

Apply these guidelines when creating or updating pull requests.

## Git Preferences

Before drafting the PR title or body, call the `GetGitPreferences` tool with:

```json
{ "type": "pr-generation" }
```

If the tool returns effective PR generation preferences, those preferences are
authoritative for drafting the title and body. Follow them before the fallback
decision algorithm below. Use the algorithm only when the tool is unavailable,
returns no effective PR generation preferences, or returns only general guidance
that does not decide a format or content requirement.

## Decision Algorithm

1. **Apply precise `GetGitPreferences` PR generation preferences** when present
2. **Check for project-specific template** (in order of precedence):
   - `.github/pull_request_template.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `.github/PULL_REQUEST_TEMPLATE/default.md`
   - `pull_request_template.md` (repo root)
   - `PULL_REQUEST_TEMPLATE.md` (repo root)

3. **If template exists** → Read it and use its structure for the PR body
4. **If no template exists** → Use the Default Sections below

## Title Format (Always Required)

Format: `[ISSUE-NUMBER] tag: Description`

- Use the ticket number from the user's ticketing system if available (for
  example, a Linear-style `[API-1234]` key)
- Use `[no-ticket]` if no ticket is associated
- Choose the appropriate conventional commit tag (see table below)
- Keep description concise and meaningful

### Conventional Commit Tags

| Tag        | Use For                 |
| ---------- | ----------------------- |
| `feat`     | New feature             |
| `fix`      | Bug fix                 |
| `chore`    | Maintenance/cleanup     |
| `refactor` | Code refactoring        |
| `docs`     | Documentation           |
| `test`     | Tests                   |
| `perf`     | Performance improvement |

### Title Examples

```
[API-1234] feat: Add user authentication endpoints
[no-ticket] fix: Resolve memory leak in cache handler
```

## Using a Project Template

When a project template exists:

1. **Read the template file** using the Read tool
2. **Fill in each section** with relevant content from the changes
3. **Remove sections** that don't apply (e.g., "To Do" if nothing remains)
4. **Keep all required sections** from the template even if brief

## Default Sections (No Template)

When no project template exists, include these sections:

- **Background**: Explain why the PR is necessary
- **Related Issue**: Link to the relevant ticketing-system issue if applicable
- **Changes**: Concise, high-level summary of what changed and why
- **To Do**: List any remaining work, or remove section if none
- **Additional Deployment and/or Rollback Steps**: Include if applicable, or remove
- **Checklists**: Keep relevant checklists, remove sections that don't apply
