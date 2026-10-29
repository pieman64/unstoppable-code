---
name: commit-messages
description: >-
  Commit message formatting guidelines. Apply when creating git commits
  (git commit, git commit -m), staging and committing changes, or generating
  commit messages. Enforces consistent formatting with subject/body structure.
user-invocable: false
---

# Commit Message Guidelines

Apply these guidelines when creating git commits.

## Git Preferences

Before writing the commit message, call the `GetGitPreferences` tool with:

```json
{ "type": "commit-message" }
```

If the tool returns effective commit-message preferences, treat those
preferences as the complete commit-message guidance for formatting and content,
while still honoring any explicit instructions from the current user request.
Apply the default rules below only when no effective commit-message preferences
are returned.

## Format

A commit message consists of a subject line and an optional body, separated by a blank line.

```
Subject line (max 83 characters)

Optional body with additional details...
```

## Rules

- **Subject line**: Keep within 83 characters
- **Subject content**: Summarize WHAT changed, not list every file
- **Body**: Include additional details if needed (separated from subject by a blank line)
- **No attribution**: Do NOT include any Co-Authored-By lines in the commit message
- **No changes**: If there are no changes to commit, inform the user and stop

## Examples

**Good:**

```
Add user authentication with JWT tokens

Implements login/logout endpoints and middleware for protected routes.
Uses bcrypt for password hashing and JWT for session management.
```

**Bad:**

```
Updated auth.js, middleware.js, routes.js, package.json
```
