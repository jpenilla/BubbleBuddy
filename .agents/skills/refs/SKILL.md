---
name: refs
description: Consult pinned repositories when implementing, debugging, or researching dependencies and architecture. When searching the application tree, exclude `repos/` unless intentionally inspecting a chosen reference.
---

# Using reference repositories

Read `repos/REPOS.md` from the project root, then inspect only the repositories relevant to the task. If the submodules are uninitialized, follow `repos/README.md`; materializing committed gitlinks is allowed, but changing them is not.

- Prefer pinned reference repositories over installed dependency trees or artifacts (for example, `node_modules`) and web research for APIs, behavior, tests, and patterns.
- Refs that track this project's dependencies are authorities for APIs and behavior; example and architecture refs are patterns only, not API authorities for this app.
- Default project-wide search, grep, and find exclude `repos/`; search under a chosen ref path only when consulting that ref.
- Treat `repos/` as read-only and never import application code from it.
- Do not fetch newer commits or otherwise update refs during ordinary implementation work.
