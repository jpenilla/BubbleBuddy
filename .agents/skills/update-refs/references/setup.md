# Reference setup

**Initialize** means materializing committed submodules in a clone. **Bootstrap** means introducing this reference system into a repository.

## Layout

Keep `.gitmodules` at the project root. Keep `README.md`, `REPOS.md`, and submodule checkouts under `repos/`; parent gitlinks pin their exact commits.

Use this `REPOS.md` table:

```markdown
| Directory | Ref | Description |
| --- | --- | --- |
```

- `Directory`: submodule path under `repos/`.
- `Ref`: intended release tag or update branch.
- `Description`: why and when the source is useful, without repeating the directory or ref.

When bootstrapping or restoring `repos/README.md`, copy [`repos-README.md`](repos-README.md) verbatim.

Project instructions should point agents to `refs` for use and `update-refs` for maintenance. Preserve important project-specific guidance rather than assuming the skills replace it.

## Bootstrap

1. Inspect repository instructions, status, resolved dependency metadata, and any existing reference convention.
2. Create the layout and inventory above; do not hand-write gitlinks.
3. Add only reference repositories with a concrete use, following [`maintenance.md`](maintenance.md).
4. Replace superseded reference paths and update formatter, linter, build, search, and similar traversal exclusions when they would otherwise enter `repos/`. Do not ignore `repos/` itself or retain legacy paths, ignores, or shims unless requested.
5. Cross-check `repos/README.md`, `repos/REPOS.md`, `.gitmodules`, gitlinks, and project instructions against this specification, then validate the complete setup.
