# Knowledge Garden Publisher Custom Domain Management Design

**Date:** 2026-10-04

## Goal

Let each blog define its own knowledge domains from the Publisher UI. A domain has a Chinese display name and a stable lowercase English path. Creating a domain makes it available immediately in note creation, filtering, and the public Quartz homepage. Users can rename the display name and delete an empty domain. Changing an established English path is intentionally deferred.

## Scope

This release supports:

- listing domains discovered in the active blog;
- creating a domain from a display name and English path;
- renaming only the display name;
- deleting a domain only when it contains no notes or other managed content;
- using dynamic domains in note creation, note paths, filters, completion ranking, and previews;
- rendering dynamic domain cards and counts on the public homepage;
- preserving domain state independently for every registered blog.

This release does not support:

- changing a domain's English path after creation;
- moving all notes between domains as part of a domain rename;
- custom domain card artwork, colors, or manual drag-and-drop ordering;
- sharing one domain registry between blogs.

## Content-Native Domain Model

The public domain landing page is the source of truth. A domain exists when the active blog contains a safe top-level file at:

```text
content/<slug>/index.md
```

Its frontmatter contains the existing public page metadata plus two domain fields:

```yaml
---
title: 人工智能
date: 2026-10-04
description: 人工智能领域的学习记录。
tags:
  - artificial-intelligence
gardenDomain: true
domainOrder: 5
---
```

The directory name is the immutable English path. `title` is the editable display name, `description` supplies the public card detail, and `domainOrder` controls stable display order. The Publisher creates a matching `private/<slug>/` directory for private notes. Empty private directories may be represented by the repository's existing keep-file convention when needed.

The four existing domain landing pages receive `gardenDomain: true` and explicit order values matching today's order:

1. reading;
2. technology;
3. language;
4. life.

New domains receive the next available order number. Deleting a domain does not renumber the remaining domains.

## Validation and Safety

Domain slugs must:

- contain only lowercase ASCII letters, digits, and single hyphen-separated segments;
- begin and end with a letter or digit;
- be unique within the active blog;
- not use reserved names such as `index`, `content`, `private`, or internal Publisher state names;
- resolve beneath the active blog's canonical `content` and `private` roots.

All domain discovery and mutation uses canonical paths, rejects symbolic links in managed ancestors, and revalidates identities immediately before filesystem changes. Renderer values are untrusted and pass through strict IPC schemas before reaching the filesystem service.

A display name is trimmed, non-empty, bounded in length, and unique by a case-insensitive comparison within the active blog. Renaming changes only the landing page title. The English path remains locked in this version.

## Main-Process Domain Service

A dedicated domain service owns discovery and mutation. It exposes the following operations through trusted IPC:

- `domains.list` returns ordered domain summaries and public/private note counts;
- `domains.create` atomically creates the landing page and required directories;
- `domains.rename` atomically updates the landing page title without rewriting unrelated Markdown;
- `domains.remove` verifies emptiness and moves the landing page and empty managed directories to the Windows Recycle Bin.

The shared `DomainSummary` contract includes the slug, display name, description, order, and counts. Failures use structured application errors for invalid input, duplicate names or paths, unsafe paths, concurrent changes, non-empty domains, and failed trash operations.

Creation is fail-closed. If a later creation step fails, the service removes only artifacts created by that operation after confirming their identities. Rename uses the existing durable Markdown replacement pattern. Removal performs a final contents and identity check immediately before trashing so a concurrent note creation cannot be lost.

## Dynamic Note Model

The fixed TypeScript union and fixed set of four domains are replaced by validated domain slugs. A note domain is accepted only when it resolves to a current, safe domain landing page in the active blog.

Note scanning continues to recurse only below `content/` and `private/`, but it includes notes only under discovered domains. Reading, saving, creating, renaming, visibility changes, trash, recovery, Wiki completion, and preview routing preserve the same containment and transaction guarantees while accepting dynamic slugs.

Domain landing pages remain metadata pages rather than editable notes in the normal note list. They are excluded from note counts and cannot be deleted through the ordinary note-delete action.

## Renderer Experience

The left sidebar's domain heading gains a `管理领域` action. It opens an accessible modal that contains:

- the ordered domain list with public/private note counts;
- a create form with `显示名称` and `英文路径` fields;
- a rename action that edits only the display name;
- a delete action with an explicit confirmation step.

The English path field displays its lowercase, hyphenated requirements while the user types. The UI shows duplicate, reserved, and invalid-path errors next to the form instead of silently disabling an operation.

Deletion is disabled for a domain with any public or private note or any unexpected file. The modal explains what must be moved first. For an empty domain, confirmation states that its landing page and empty managed directories will be moved to the Windows Recycle Bin.

The note-creation domain selector and sidebar filters consume the same live domain list. After creating or renaming a domain, both update without restarting. After deleting a domain, its filter disappears and the filter returns to `全部领域` if necessary.

## Public Quartz Homepage

`GardenOverview` no longer contains a hardcoded domain array. It derives cards from top-level public index pages whose frontmatter contains `gardenDomain: true`.

For each domain it:

1. validates and reads the top-level slug;
2. uses `title` and `description` for card text;
3. counts visible public notes beneath that slug while excluding index pages and unlisted notes;
4. sorts by `domainOrder`, with a deterministic slug fallback for malformed or missing legacy order values;
5. links to `<slug>/index` using Quartz relative-path helpers.

The header reports the actual number of visible notes and discovered domains. Invalid domain metadata is excluded rather than breaking the entire site build. Publisher validation surfaces the problem to the user so it can be repaired.

## Multi-Blog Behavior

Domain data lives inside each blog repository. Switching blogs and relaunching the Publisher reloads the active repository's domain landing pages. No global domain file is stored in Electron user data, and domains from one blog cannot appear in another blog's selector or homepage.

Domain mutations participate in the same switch and close barriers as note mutations. The app cannot switch blogs or quit while a domain filesystem transaction has an uncertain outcome.

## Error Handling

- Invalid or duplicate input leaves the modal open and focuses the relevant field.
- A stale domain list triggers a fresh discovery before mutation and returns a clear conflict if the requested state changed.
- A non-empty domain is never partially removed.
- A failed rename preserves the original landing page.
- A failed trash operation reports what remains and does not remove the domain from renderer state.
- Quartz metadata errors identify the affected landing page without blocking unrelated note editing.
- Preview refresh failures retain the last successful preview and show the existing preview error state.

## Testing and Verification

Unit and integration coverage will include:

- domain discovery, ordering, and exclusion of unsafe or malformed entries;
- slug, reserved-name, display-name, duplicate, and canonical-path validation;
- atomic creation and rollback;
- title-only rename with unchanged slug and note paths;
- refusal to remove domains containing public notes, private notes, attachments, or unexpected files;
- successful trash of an empty domain with concurrent-change protection;
- dynamic note operations under custom domains;
- IPC schemas, sender trust, and preload exposure;
- renderer create, rename, validation, confirmation, focus, and live-list behavior;
- dynamic Quartz cards, order, links, counts, and total-domain text;
- isolation when switching between two blogs with different domain sets.

Desktop end-to-end verification will cover:

1. create a custom domain;
2. create a public and a private note in it;
3. verify filters and preview routes;
4. restart and confirm persistence;
5. confirm deletion is blocked while notes exist;
6. move or remove test notes, delete the empty domain, and confirm its files are recoverable from the trash adapter;
7. build the Quartz site and verify the new public domain card and counts.

The final packaged build must pass formatting, type checking, the complete Vitest suite, desktop Playwright tests, packaging, installation, and an installed-application smoke test.

## Future Extension

A later release may allow English-path changes. That work requires a planned multi-file transaction that moves public and private trees, rewrites approved Wiki links, detects URL collisions, preserves aliases or redirects, and reports deployment consequences. It is intentionally separate from display-name renaming in this design.
