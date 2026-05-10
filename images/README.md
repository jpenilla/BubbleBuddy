# Images

This directory contains example custom Gondolin image configs with a larger rootfs and extra tools installed.

Available images:

- `agent-x86_64`

Build an image by name:

```bash
pnpm exec gondolin build --config ./images/<name>.json --output ./images/<name> --tag <name>:latest
```

For example:

```bash
pnpm exec gondolin build --config ./images/agent-x86_64.json --output ./images/agent-x86_64 --tag agent-x86_64:latest
```
