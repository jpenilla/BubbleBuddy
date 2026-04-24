import { constants } from "node:fs";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type ExtensionFactory,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { Effect } from "effect";

export interface GondolinExtensionOptions {
  readonly channelId: string;
  readonly sessionCwd: string;
  readonly sessionLabel?: string;
  readonly workspaceDir: string;
}

export interface GondolinExtension {
  readonly dispose: () => Promise<void>;
  readonly extensionFactory: ExtensionFactory;
}

const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const createGondolinExtension = (options: GondolinExtensionOptions): GondolinExtension => {
  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;

  const ensureVm = async (): Promise<VM> => {
    if (vm !== undefined) {
      return vm;
    }

    if (vmStarting !== undefined) {
      return vmStarting;
    }

    void Effect.runFork(Effect.logInfo(`Starting Gondolin VM for channel ${options.channelId}.`));
    vmStarting = VM.create({
      sessionLabel: options.sessionLabel,
      vfs: {
        mounts: {
          [options.sessionCwd]: new RealFSProvider(options.workspaceDir),
        },
      },
    }).then(
      (created) => {
        vm = created;
        vmStarting = undefined;
        return created;
      },
      (error) => {
        void Effect.runFork(
          Effect.logWarning(
            `Failed to start Gondolin VM for channel ${options.channelId}: ${String(error)}`,
          ),
        );
        vmStarting = undefined;
        throw error;
      },
    );

    return vmStarting;
  };

  const dispose = async (): Promise<void> => {
    const active = vm ?? (await vmStarting?.catch(() => undefined));
    vm = undefined;
    vmStarting = undefined;

    if (active !== undefined) {
      void Effect.runFork(Effect.logInfo(`Closing Gondolin VM for channel ${options.channelId}.`));
      await active.close();
    }
  };

  const readOperations: ReadOperations = {
    access: async (path) => {
      await (await ensureVm()).fs.access(path, { mode: constants.R_OK });
    },
    detectImageMimeType: async (path) => {
      const result = await (
        await ensureVm()
      ).exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(path)}`]);
      if (!result.ok) {
        return null;
      }

      const mimeType = result.stdout.trim();
      return IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
    },
    readFile: async (path) => await (await ensureVm()).fs.readFile(path),
  };

  const writeOperations: WriteOperations = {
    mkdir: async (dir) => {
      await (await ensureVm()).fs.mkdir(dir, { recursive: true });
    },
    writeFile: async (path, content) => {
      await (await ensureVm()).fs.writeFile(path, content);
    },
  };

  const editOperations: EditOperations = {
    access: async (path) => {
      await (await ensureVm()).fs.access(path, { mode: constants.R_OK | constants.W_OK });
    },
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
  };

  const bashOperations: BashOperations = {
    exec: async (command, cwd, options) => {
      const abortController = new AbortController();
      const onAbort = (): void => abortController.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timeoutHandle =
        options.timeout !== undefined && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              abortController.abort();
            }, options.timeout * 1000)
          : undefined;

      try {
        const process = (await ensureVm()).exec(["/bin/bash", "-c", command], {
          cwd,
          signal: abortController.signal,
          stderr: "pipe",
          stdout: "pipe",
        });

        for await (const chunk of process.output()) {
          options.onData(chunk.data);
        }

        const result = await process;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error("aborted");
        }

        if (timedOut) {
          throw new Error(`timeout:${options.timeout}`);
        }

        throw error;
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  return {
    dispose,
    extensionFactory: (pi) => {
      pi.registerTool(createReadToolDefinition(options.sessionCwd, { operations: readOperations }));
      pi.registerTool(
        createWriteToolDefinition(options.sessionCwd, { operations: writeOperations }),
      );
      pi.registerTool(createEditToolDefinition(options.sessionCwd, { operations: editOperations }));
      pi.registerTool(createBashToolDefinition(options.sessionCwd, { operations: bashOperations }));

      pi.on("session_shutdown", async () => {
        await dispose();
      });
    },
  };
};
