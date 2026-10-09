# Reference setup

**Initialize** means materializing committed submodules in a clone. **Bootstrap** means introducing this reference system into a repository.

## Layout

Keep `.gitmodules` at the project root. Keep `README.md`, `REFS.md`, and submodule checkouts under `.refs/`; parent gitlinks pin their exact commits.

Use this `REFS.md` table:

```markdown
| Directory | Ref | Description |
| --- | --- | --- |
```

- `Directory`: submodule path under `.refs/`.
- `Ref`: intended release tag or update branch.
- `Description`: why and when the source is useful, without repeating the directory or ref.

When bootstrapping or restoring `.refs/README.md`, copy [`refs-README.md`](refs-README.md) verbatim.

Project instructions should point agents to `refs` for use and `update-refs` for maintenance. Preserve important project-specific guidance rather than assuming the skills replace it.

## Bootstrap

1. Inspect repository instructions, status, resolved dependency metadata, and any existing reference convention.
2. Create the layout and inventory above; do not hand-write gitlinks.
3. Add only reference repositories with a concrete use, following [`maintenance.md`](maintenance.md).
4. Replace superseded reference paths and update formatter, linter, build, search, and similar traversal exclusions when they would otherwise enter `.refs/`. Do not retain legacy paths, ignores, or shims unless requested.
5. Cross-check `.refs/README.md`, `.refs/REFS.md`, `.gitmodules`, gitlinks, and project instructions against this specification, then validate the complete setup.
