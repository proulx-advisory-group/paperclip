import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

describe("claude local execution (G1: cleanup kill is not a failure)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not mark the run failed when our own terminalResultCleanup killed a child that had already emitted a clean result", async () => {
    // This is the exact shape of the SHIP-1350 misclassification: the CLI wrote a
    // successful terminal result, kept the process alive, our own cleanup timer
    // sent SIGTERM, and the child trapped it and exited 143. `proc.stoppedBy`
    // names that as our own kill; without it, exitCode 143 alone reads as a crash.
    runChildProcess.mockResolvedValue({
      exitCode: 143,
      signal: null,
      timedOut: false,
      stoppedBy: "terminal_result_cleanup",
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
        JSON.stringify({
          type: "result",
          session_id: "claude-session-1",
          is_error: false,
          result: "done",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsPath = path.join(rootDir, "instructions.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the local workspace.\n", "utf8");

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        env: {},
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/local-claude",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
        ],
      },
      onLog: async () => {},
    } as Parameters<typeof execute>[0]);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(143);
    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
  });
});
