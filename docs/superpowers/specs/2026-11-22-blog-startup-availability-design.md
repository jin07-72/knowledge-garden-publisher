# Blog Startup Availability Design

## Problem

The publisher currently uses the full blog-import inspection to decide whether the active local blog is available at startup. That inspection checks both local files and Git repository details, including the `origin` remote. A temporary Git command failure therefore sends an existing, editable blog to the “博客恢复” screen with the inaccurate message that its folder is unavailable.

The observed blog at `C:\Users\11546\Desktop\web` exists, its registry record is valid, and the same packaged build opens it normally after a restart. The startup gate must distinguish local editing availability from publishing readiness.

## Desired Behavior

- The application opens an active blog when its registered canonical directory still exists and its local editing structure is safe.
- Local editing availability requires the workspace root, `content`, and `private` to be real workspace-owned directories.
- Git executable, repository, remote, dependency, preview-runtime, and website failures do not trigger blog recovery.
- Those tooling failures remain visible through the existing startup diagnostics and may disable only the affected preview or publishing actions.
- A missing, moved, linked, or structurally unsafe local blog still opens the recovery screen.
- Adding, cloning, or recovering a registered blog continues to use the strict candidate validation, including Git repository and `origin` checks. This change must not weaken import trust boundaries.

## Architecture

Introduce a separate local-availability inspection dependency alongside the existing strict candidate inspection.

1. `inspectWorkspaceSafety` remains the source of truth for local editing safety.
2. A small adapter maps its result to the canonical-path result needed by blog runtime and registry availability checks.
3. `BlogRuntime.active()` and target validation during an existing-blog switch use the local-availability inspector.
4. `BlogManagementAdapter.services.list()` uses the same local-availability inspector when computing `activeAvailability`.
5. `chooseLocal`, `addLocal`, `recoverLocal`, and clone/import validation keep using `inspectBlogCandidate` unchanged.

Keeping these dependencies explicit prevents future code from accidentally using publishing readiness as a proxy for local folder existence.

## Data Flow

At startup:

1. Load `blogs.json` and locate the active record.
2. Inspect the record’s canonical path with the local-availability inspector.
3. Confirm the returned canonical path matches the stored canonical path.
4. Start the editor workspace when safe.
5. Run the existing full startup diagnostics separately; surface Git, dependency, preview, or publication issues without replacing the editor with recovery UI.

For registration and recovery flows, strict candidate inspection remains unchanged.

## Error Handling

- Filesystem inspection failures and canonical-path mismatches map to `BLOG_WORKSPACE_UNAVAILABLE` and retain the existing recovery UI.
- Tooling failures never map to local unavailability.
- The recovery UI message continues to mean that the local path or its required editing structure is genuinely unavailable.
- No automatic registry mutation, path relocation, or Git configuration change occurs during startup.

## Testing

Use test-driven development with a failing regression before production changes.

- Blog runtime accepts a locally safe active blog even when strict Git inspection would fail.
- Blog runtime still rejects missing, unsafe, or canonical-path-mismatched workspaces.
- Blog listing reports `activeAvailability: "available"` from local safety while strict candidate validation can independently fail.
- Add/recover/import tests prove strict Git and `origin` validation remains enforced.
- Renderer regression proves tooling diagnostics do not replace the editor with the recovery screen.
- Packaged Electron verification launches against the real registered blog and confirms the main interface appears instead of “博客恢复”.

## Scope

This change only corrects startup and registered-blog availability semantics. It does not change publishing, branch handling, remote configuration, appearance preview behavior, or registry file format.
