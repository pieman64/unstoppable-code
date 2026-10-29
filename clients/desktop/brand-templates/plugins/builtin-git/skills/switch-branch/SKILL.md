---
name: switch-branch
description: >-
  {% if claude %}/builtin-git:switch-branch{% else %}$builtin-git:switch-branch{% endif %} only. Switch to an existing branch
---

# Switch Branch

The user wants to switch to an existing branch. Input provided: "the user request".

## Instructions

### Step 1: Get Branch Name

**Arguments received**: `the user request`

If no arguments are provided, use `AskUserQuestion` to ask the user to provide the name of an existing branch to switch to.

### Step 2: Validate Branch Exists

The branch name must be an existing branch either locally or in the remote origin. This validation is strict - no sanitization or branch name generation is performed.

**Validation steps:**

1. Fetch the latest remote refs using `git fetch origin`
2. Check if the branch exists locally using `git show-ref --verify --quiet refs/heads/<branch-name>`
3. If not found locally, check if it exists on origin using `git show-ref --verify --quiet refs/remotes/origin/<branch-name>`

**If validation fails:**
Display an error message indicating the branch does not exist. Show a list of available local and remote branches using `git branch -a` and use `AskUserQuestion` to prompt the user for a valid branch name. Repeat validation until a valid branch is provided.

### Step 3: Execute Git Workflow

Perform the following git workflow:

1. **Verify git repository**: Run `git rev-parse --is-inside-work-tree` to verify you are inside a git repository. If this fails, stop and report that no git repository was found.
2. **Stash current changes**: Stash any uncommitted changes (including untracked files) using `git stash push -u -m "Auto-stash before branch switch"`
3. **Checkout the branch**:
   - If the branch exists locally, switch to it using `git checkout <branch-name>`
   - If the branch only exists on origin, create a local tracking branch using `git checkout -t origin/<branch-name>`
4. **Pull latest changes**: Pull the latest changes using `git pull`. If merge conflicts occur, stop and inform the user that conflicts must be resolved manually before continuing.
5. **Restore stashed changes**: If changes were stashed in step 2, restore them using `git stash pop`. If there are conflicts during stash pop, inform the user.

Use the Bash tool to execute these git commands sequentially. If any step fails, stop and report the error to the user.
