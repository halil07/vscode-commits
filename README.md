# CommitPro for VS Code

A Clean Code Visual Studio Code extension providing enterprise-grade Git version control workflows: Dynamic Changelists, Non-Modal Commit Tool Window with Pre-Commit Quality Gates, 3-Pane Conflict Resolver with Magic Wand, Swimlane DAG Git Log, Visual Interactive Rebase Console, Patch Shelf, Git Worktrees, Multi-Root Synchronization, and Age-Colored Git Blame.

## Features & Architecture

### 1. Repository, Multi-Root, Submodule, Ignore & Worktree Management (`src/modules/repository/`)
- **Multi-Root Discovery & Directory Mappings**: Recursively discovers `.git` roots across workspace folders and supports explicit `commitPro.directoryMappings`.
- **Synchronous Multi-Root Branch Control**: `commitPro.synchronousBranchControl` (*Execute branch operations on all roots*) executes branch checkouts, branch creation, and project updates across all registered repositories simultaneously.
- **Submodule Inspector**: Automatically detects Git submodules (`git submodule status`) and highlights detached `HEAD` states.
- **3-Tier `.gitignore` & `.git/info/exclude` + Safe Untracking**: Adds ignore rules to Root `.gitignore`, Directory-level `.gitignore`, or local `.git/info/exclude` while safely untracking already-committed files via `git rm --cached` without deleting the working copy.
- **Git Worktree Manager**: Dedicated `Git Worktrees` manager (`commitPro.createWorktree`) to create, switch, and remove isolated worktrees with automatic `.worktreeinclude` (e.g. `.env.local`) file copying.

### 2. Dynamic Changelists, SCM & Partial Chunk Operations (`src/modules/changelist/`)
- **Dynamic Changelists**: Create unlimited named Changelists alongside the default `Changes` list, set an **Active Changelist** that automatically receives new edits, and move files between Changelists.
- **Dual Mode Toggle**: Switch on the fly between `"changelist"` mode and native Git `"index"` staging mode (`commitPro.stagingMode`).
- **QuickDiff & Line/Chunk Operations**: Live editor gutter diff decorations via `QuickDiffProvider` (`commitpro-orig:`), **Rollback Selected Lines**, and **Stage Selected Lines / Hunk** (`git apply --cached --unidiff-zero`).

### 3. Non-Modal Commit Tool Window (`Alt+0`) & Pre-Commit Quality Gates (`src/modules/commit/`)
- **Commit Tool Window**: Non-modal commit workflow featuring Changelist selection, per-file checkboxes, 72-character commit message counter, commit history recall, **Amend**, **Sign-off (`--signoff`)**, **GPG Sign (`-S`)**, **Author override**, **Commit**, and **Commit and Push… (`Ctrl+Alt+K`)**.
- **Pre-Commit Quality Gates**:
  - **Reformat Code**: Runs VS Code's document formatter on modified files.
  - **Optimize Imports**: Runs `source.organizeImports` code actions on modified files.
  - **Analyze Code**: Inspects LSP diagnostics for errors before allowing commit.
  - **Check TODO/FIXME**: Scans modified files for `TODO` / `FIXME` markers and asks for confirmation.

### 4. Branches Popup, 3-Pane Conflict Resolver & Interactive Rebase (`src/modules/branches/`)
- **VCS Branch Status Bar Widget & Popup**: Shows active branch, incoming (`↓`) and outgoing (`↑`) commit counts, and opens a hierarchical popup with Top Actions, Recent Branches, Local Branches, Remote Branches, and per-branch submenu (*Checkout*, *Checkout and Update*, *Compare with Current*, *Show Diff with Working Tree*, *Rebase Current onto Selected*, *Merge into Current*, *Rename*, *Delete*).
- **3-Pane Visual Conflict Resolver**: Full-screen 3-pane merge editor (`Left: Yours`, `Center: Editable Result initialized from Base`, `Right: Theirs`) with synchronized scrolling, **✨ Magic Wand (Apply All Non-Conflicting Changes)** powered by `Diff3Engine`, **Resolve Simple Conflicts**, and per-region `>>` / `<<` / `✕` buttons.
- **Visual Interactive Rebase Console**: Graphical table for reordering commits and assigning `PICK`, `REWORD`, `EDIT`, `SQUASH`, `FIXUP`, or `DROP` actions, executed automatically via `GIT_SEQUENCE_EDITOR`.

### 5. Swimlane DAG Git Log (`Alt+9`), Git Blame, Protected Branches & Shelf (`src/modules/audit/`)
- **Swimlane DAG Git Log & Console**: Bottom panel (`Alt+9` / `Cmd+9`) rendering a multi-lane SVG commit graph, ref badges (`HEAD`, local, remote, tags), filters (*Text/Regex*, *Branch/Range `b1..b2`*, *User*, *Date*, *Path*), Changed Files inspector, commit actions (*Cherry-Pick*, *Interactive Rebase Here*, *Reset Branch*, *Revert*, *New Tag*, *Push All up to Here*), and a live **Git Console** tab.
- **Annotate with Git Blame & Selection History**: Age-colored inline blame annotations with commit hover cards, plus **Show History for Selection** (`git log -L <start>,<end>:<file>`).
- **Protected Branches Shield & Update Project**: Blocks `--force` push and history rewriting on `main`, `master`, `release/*`, and provides **Update Project (`Ctrl+T`)** (*Merge*, *Rebase*, *Reset*) and **Push (`Ctrl+Shift+K`)** dialogs.
- **Patch Shelf & Native Stash**: Stores `.patch` files and Base commit metadata in `.vscode/commit-pro/shelf/`, allowing unshelving onto dirty working trees with 3-way conflict resolution (`git apply --3way`).

## Build & Debug

```bash
pnpm install
pnpm run compile
```

Press `F5` in VS Code to launch **Run CommitPro Extension** in the Extension Development Host window.
