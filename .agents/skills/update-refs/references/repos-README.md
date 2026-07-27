# Reference repositories

Reference repositories are configured here as shallow Git submodules. They are read-only: do not edit them and do not import application code from them.

The current inventory and intended refs are recorded in [`REPOS.md`](./REPOS.md). The parent repository's Git submodule links pin exact commits; shallow initialization only limits downloaded history, and local checkouts may be full clones.

## Initialize a clone

After cloning, or after `.gitmodules` changes:

```bash
git submodule sync
git submodule update --init --depth 1
```

Use the project skills under `.agents/skills/`: `refs` for consulting these repositories and `update-refs` for maintaining them.
