# Images

This directory contains example custom Gondolin image configs with a larger rootfs and extra tools installed.

Available images:

- `agent-x86_64`

Build an image by name:

```bash
pnpm --filter bubblebuddy exec gondolin build --config ./tools/gondolin-images/<name>.json --output ./tools/gondolin-images/<name> --tag <name>:latest
```

For example:

```bash
pnpm --filter bubblebuddy exec gondolin build --config ./tools/gondolin-images/agent-x86_64.json --output ./tools/gondolin-images/agent-x86_64 --tag agent-x86_64:latest
```
