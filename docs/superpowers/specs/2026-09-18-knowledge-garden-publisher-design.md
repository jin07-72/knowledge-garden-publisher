# Knowledge Garden Publisher Design

## 1. Purpose

Build a Windows desktop application for writing, previewing, publishing, and viewing the existing Knowledge Garden. The application should let the user manage the full daily workflow without remembering terminal commands while preserving Markdown files, Git history, Quartz, and GitHub Pages as the source-of-truth publishing system.

The first version manages one existing garden at `C:\Users\11546\Desktop\web`. It is a local-first tool: notes remain ordinary files, the public website remains a static Quartz site, and publishing remains a normal Git commit followed by the existing GitHub Actions workflow.

## 2. Confirmed Product Decisions

- Platform: installable Windows desktop application.
- Desktop shell: Electron.
- UI stack: React and TypeScript.
- Editor: an embedded Markdown editor based on CodeMirror 6; Obsidian is not required.
- Layout: three panes, with the note list on the left, Markdown editor in the center, and live preview on the right.
- Visibility control: a compact dark `公开 / 私密` dropdown in the editor header, modeled after the user-provided reference.
- Privacy model: physical separation between `content/` and `private/`; a frontmatter flag alone is not considered private.
- Publish selection: show a review list before publishing. Public changes are selected by default; private files are visible only as locked local changes and cannot be selected.
- Viewing: include the note list, local Quartz preview, live public site, local Git history, and GitHub Actions deployment history.
- Existing repository, theme, content validation, link validation, and GitHub Pages deployment remain authoritative.

## 3. Reuse Strategy

Research found useful existing products but no mature application that exactly matches this repository and workflow:

- Quartz Syncer demonstrates selective Quartz publishing, change previews, and deployment status inside Obsidian.
- Obsidian Git demonstrates reliable commit, pull, push, history, and diff workflows inside a note editor.
- Quiqr demonstrates a local-first desktop CMS with integrated Git publishing and site preview.
- MarkText demonstrates a mature Windows Markdown editing experience.

The application will reuse the architectural lessons and established libraries rather than fork an unrelated full product. It will not rebuild Quartz, Git, or Markdown parsing. The existing site is already complete, so the application is a focused control surface over that system.

## 4. Application Architecture

### 4.1 Process Boundaries

The Electron main process owns privileged operations:

- reading, writing, moving, and trashing local files;
- launching and stopping the Quartz preview process;
- running validation and Git commands;
- creating isolated publish snapshots;
- querying public GitHub Actions status;
- opening the live site in a sandboxed application view or the system browser.

The renderer process owns presentation and editing state:

- note tree, search, and filters;
- CodeMirror editor state;
- frontmatter assistance and Wiki-link completion;
- local/live preview tabs;
- publish review and progress screens;
- history and diagnostics.

The renderer has no direct Node.js access. Electron uses `contextIsolation: true`, `nodeIntegration: false`, a narrow preload bridge, and explicitly allowlisted IPC messages. Remote content never receives filesystem or process access.

### 4.2 Application Modules

Each module has one bounded responsibility:

- **Workspace service:** validates the configured garden path and exposes repository capabilities.
- **Note index:** scans `content/` and `private/`, parses required metadata, and maintains searchable summaries.
- **Note editor:** loads and atomically saves Markdown without changing unsupported syntax.
- **Visibility service:** moves notes and owned attachments between public and private roots.
- **Preview manager:** runs Quartz locally and reports readiness, rebuild errors, and the preview URL.
- **Change service:** calculates working-tree changes and groups notes with their owned attachments.
- **Publish snapshot service:** builds and verifies exactly the files selected for publication.
- **Git service:** creates commits, pulls when safe, pushes to `origin/main`, and reads local history.
- **Deployment monitor:** polls the public GitHub Actions API with backoff and links failures to the relevant run.
- **Recovery service:** maintains local recovery snapshots and restores interrupted edits.

The UI consumes typed results from these modules and does not parse raw command output directly.

## 5. Workspace and Content Model

### 5.1 Managed Roots

- Public notes: `content/<domain>/<slug>.md`
- Private notes: `private/<domain>/<slug>.md`
- Public owned attachments: `content/_assets/<slug>/...`
- Private owned attachments: `private/_assets/<slug>/...`
- Local application state: `.garden-publisher/`, ignored by Git

The four initial domains remain `technology`, `reading`, `language`, and `life`.

### 5.2 Note Identity

A note is identified by its domain and lowercase slug. A public/private move preserves the slug and domain. Required frontmatter remains `title`, `date`, `description`, and `tags`. The editor provides assistance for those fields but preserves the complete Markdown source.

Renaming a slug or moving a note between domains runs as a planned transaction. The application detects incoming Wiki links, previews the affected files, updates approved references together, and aborts the whole operation if any write or collision check fails. The original slug is added to the note's aliases when supported by the existing Quartz configuration so previously shared links continue to resolve.

Existing attachments outside the owned-attachment convention remain readable. Before changing visibility, the application scans Markdown links. If it cannot safely determine ownership, it stops and asks the user to resolve or explicitly relocate the attachment rather than guessing.

### 5.3 Visibility Transitions

Visibility changes use a preflight and an atomic move:

1. Save the current editor buffer.
2. Validate the target path and reject collisions.
3. Resolve the note-owned attachment directory.
4. Verify that the move will not expose or lose referenced files.
5. Move the note and owned attachments.
6. Re-index notes and refresh preview state.

Moving a previously public note to `private/` does not immediately remove the already-deployed page. The UI records a pending public deletion and clearly shows `仍在线，等待发布下架`. The publish checklist can stage the deletion of the old `content/` path while the new private file remains ignored and unstaged.

Privacy is prospective, not retroactive. A note that was previously committed publicly can remain visible in Git history even after the current page is removed. Before privatizing a tracked note, the UI warns about that history. Rewriting already-published Git history is destructive, affects shared repository state, and is deliberately outside the first version.

Moving a private note to `content/` creates a new public change that is eligible for publication. A note that has always been private never appears as a Git change or publication candidate.

## 6. User Interface

### 6.1 Main Window

The selected layout contains:

- **Left pane:** domains, public/private filters, search, note list, and new-note action.
- **Center pane:** Markdown source editor with syntax highlighting, Wiki-link completion, find/replace, and save state.
- **Right pane:** live local Quartz preview of the active note.
- **Editor header:** garden identity, current path, and the compact `公开 / 私密` dropdown.
- **Bottom status bar:** unsaved state, preview state, number of publishable changes, and `检查并发布`.

Secondary views provide the full local site, live public site, local commit history, and deployment history without replacing the primary three-pane writing layout.

### 6.2 Visibility Dropdown

The dropdown uses a short label, dark background, colored status dot, and down arrow. Each option includes a plain-language consequence:

- `公开` — enters the website and GitHub after publication.
- `私密` — remains only on this computer.

The application never performs a visibility move while an editor save is incomplete.

### 6.3 Publish Review

The publish review shows one row per logical change group:

- checked public note changes;
- associated owned attachments;
- public deletions created by making a formerly public note private;
- locked private local changes that cannot be selected;
- repository or configuration changes as a separate advanced section, unchecked by default.

The footer states the number of notes and attachments to publish. `验证并发布` begins snapshot verification. The button cannot bypass failed validation.

### 6.4 Destructive Operations

Deleting a note always requires confirmation and uses Electron's Windows recycle-bin integration. It does not permanently delete the file. Deleting or privatizing a published note warns that the online copy remains available until its public deletion is successfully deployed.

## 7. Editing and Preview Flow

1. Opening a note loads its raw Markdown and parsed metadata.
2. Editor changes are debounced and written atomically through a temporary sibling file and rename.
3. Recovery snapshots are kept under `.garden-publisher/recovery/` and are never committed.
4. A successful save notifies the running Quartz preview process.
5. The right pane refreshes only after Quartz reports a successful incremental rebuild.
6. If Quartz reports an error, the last successful preview remains visible with an error banner and a link to the relevant source location.

The local preview uses Quartz rather than a separate Markdown renderer so that Wiki links, callouts, graph-related markup, syntax highlighting, and theme styles match the deployed site.

## 8. Exact-Selection Publishing

Publishing selected files must not accidentally include unselected local work or validate a different tree from the one pushed.

The snapshot service uses a temporary Git index and detached worktree:

1. Refuse to publish while an unrelated real Git index already contains staged changes.
2. Create a temporary index initialized from `HEAD` using `GIT_INDEX_FILE`.
3. Add only the selected public paths, associated attachments, and selected public deletions to that temporary index.
4. Write the temporary tree and create a synthetic commit whose parent is the current `HEAD`.
5. Create a temporary detached worktree from the synthetic commit.
6. Install the lockfile-defined dependencies or reuse a verified local dependency cache.
7. Run `npm run verify:site` in the temporary worktree.
8. If verification succeeds, create the real commit from the identical temporary index tree and update the current branch.
9. Push the current branch to `origin/main`.
10. Remove the temporary worktree and index in all success and failure paths.

Unselected working-tree edits remain untouched. A snapshot failure produces no commit and no push.

Before pushing, the Git service fetches `origin/main`. If the remote cannot be fast-forwarded safely, publishing stops and reports the divergence. The application never force-pushes, resets, or discards user work.

## 9. Deployment Monitoring

After a successful push, the deployment monitor locates the GitHub Actions run for the pushed commit and displays:

- queued;
- building and validating;
- deploying;
- live;
- failed or cancelled.

The repository is public, so the first version can use GitHub's public REST endpoints with ETags and exponential backoff. It does not store a GitHub token. Git pushes continue to use the existing Windows Git Credential Manager configuration.

If status polling is rate-limited or unavailable, publishing still succeeds and the UI falls back to links for the repository Actions page and live site.

## 10. Failure Handling

- **Invalid frontmatter:** block publication and focus the missing or invalid field.
- **Broken Wiki link or attachment:** list the source file, target, and suggested correction.
- **Visibility collision:** perform no move and present both conflicting paths.
- **Preview build failure:** retain the last successful preview and show the build error.
- **External file edit:** detect the changed modification time before saving, preserve the editor buffer, and ask the user to reload or compare rather than overwriting the external change.
- **Existing staged Git changes:** block application-managed publishing until the user resolves them.
- **Remote divergence or conflict:** stop before commit/push; never overwrite remote or local work.
- **No network:** allow editing, saving, search, history, and local preview; keep publication pending.
- **Push failure:** retain the created local commit and offer a safe retry.
- **GitHub Actions failure:** keep the previous live site online and show the failed step plus run link.
- **Unexpected shutdown:** offer recovery from the newest local recovery snapshot on next launch.

Errors are expressed in user terms first, with an expandable technical log for diagnosis.

## 11. Installation and First Run

The first version produces a per-user Windows installer and does not require administrator access. The installer bundles the pinned Node.js and npm runtime used for Quartz commands, so site preview and validation do not depend on a separately installed Node version. The application checks:

- the configured workspace exists and is the expected Git repository;
- required repository files and scripts exist;
- Git is installed and usable;
- `origin/main` is reachable when online;
- Node dependencies match `package-lock.json`;
- the local preview port is available;
- Windows Git credentials can perform a safe read operation.

Missing dependencies trigger guided repair actions. The application never asks the user to paste a GitHub password or token into its settings.

## 12. Testing Strategy

### 12.1 Unit Tests

- frontmatter parsing and preservation;
- path and slug validation;
- visibility transition planning;
- attachment ownership and collision detection;
- logical change grouping;
- deployment-state mapping;
- command-output adapters.

### 12.2 Integration Tests

Temporary Git repositories verify:

- public-to-private and private-to-public transitions;
- published-note removal without staging the private replacement;
- selected publication without including unrelated edits;
- synthetic snapshot tree equality with the final commit tree;
- validation failure producing no commit;
- non-fast-forward remote detection;
- recovery after process interruption.

### 12.3 UI and Packaged Tests

- editor load, autosave, and recovery;
- visibility dropdown keyboard and pointer behavior;
- publish checklist selection and locked private rows;
- preview success and error states;
- history and deployment status;
- installer launch on a clean supported Windows environment;
- accessibility for keyboard navigation, focus indicators, and status announcements.

The existing `npm run verify:site` remains the publication acceptance check.

## 13. First-Version Scope

Included:

- one fixed Knowledge Garden workspace;
- note creation, rename, search, filters, editing, and recycle-bin deletion;
- the four existing domains;
- Markdown highlighting, Wiki-link completion, autosave, and recovery;
- split editor and exact Quartz preview;
- public/private moves and owned-attachment handling;
- local site, live site, Git history, and deployment history;
- reviewed selective publication and deployment monitoring;
- guided first-run diagnostics;
- a per-user Windows installer.

Explicitly excluded from the first version:

- multiple gardens;
- mobile applications or private cross-device sync;
- accounts, teams, or collaboration;
- a Notion-style block editor;
- AI writing features;
- custom-domain management;
- a plugin marketplace;
- automatic application updates.

## 14. Completion Criteria

The first version is complete when the user can install the application, open the existing garden, create or edit a Markdown note, preview the exact Quartz output, change the note between public and private without exposing private source or attachments, select public changes, pass isolated publication validation, push them, observe deployment status, and open the resulting live page without using a terminal.

All privacy, exact-selection publishing, recovery, and non-destructive Git integration tests must pass. The packaged application must launch and complete a publish smoke test on Windows using the existing repository and Git credential configuration.
