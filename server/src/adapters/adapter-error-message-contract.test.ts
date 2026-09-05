import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findAdapterErrorMessageContractViolations } from "./adapter-error-message-contract.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every built-in, in-repo adapter type mapped to the file that implements its
 * `execute()`. Deliberately excludes `hermes_local`: it's a third-party npm
 * package (`hermes-paperclip-adapter`), not source we carry or can statically
 * check here — a named gap, not a silent one.
 */
const ADAPTER_EXECUTE_SOURCE_FILES: Record<string, string> = {
  acpx_local: "packages/adapters/acpx-local/src/server/execute.ts",
  claude_local: "packages/adapters/claude-local/src/server/execute.ts",
  codex_local: "packages/adapters/codex-local/src/server/execute.ts",
  cursor: "packages/adapters/cursor-local/src/server/execute.ts",
  cursor_cloud: "packages/adapters/cursor-cloud/src/server/execute.ts",
  gemini_local: "packages/adapters/gemini-local/src/server/execute.ts",
  openclaw_gateway: "packages/adapters/openclaw-gateway/src/server/execute.ts",
  opencode_local: "packages/adapters/opencode-local/src/server/execute.ts",
  pi_local: "packages/adapters/pi-local/src/server/execute.ts",
  copilot_local: "packages/adapters/copilot-local/src/server/execute.ts",
  process: "server/src/adapters/process/execute.ts",
  http: "server/src/adapters/http/execute.ts",
};

const KNOWN_UNCHECKABLE_BUILTIN_TYPES = new Set(["hermes_local"]);

describe("adapter errorMessage contract (TNM-287)", () => {
  it("covers every built-in adapter type known to the registry", () => {
    // If this fails, a built-in adapter was added to BUILTIN_ADAPTER_TYPES
    // without being wired into this guard — add its execute() source path
    // to ADAPTER_EXECUTE_SOURCE_FILES (or, if it's a third-party package
    // like hermes_local, to KNOWN_UNCHECKABLE_BUILTIN_TYPES with a reason).
    for (const type of BUILTIN_ADAPTER_TYPES) {
      const covered = type in ADAPTER_EXECUTE_SOURCE_FILES || KNOWN_UNCHECKABLE_BUILTIN_TYPES.has(type);
      expect(covered, `adapter type "${type}" is neither guarded nor declared uncheckable`).toBe(true);
    }
  });

  it.each(Object.entries(ADAPTER_EXECUTE_SOURCE_FILES))(
    "%s's execute() never returns a non-zero exitCode with a null/absent errorMessage",
    (_type, relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      const source = readFileSync(absolutePath, "utf8");
      const violations = findAdapterErrorMessageContractViolations(source, absolutePath);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    },
  );

  describe("checker mechanics (proven against synthetic sources, not just today's adapters)", () => {
    it("flags a failure return that has no errorMessage and no earlier guard (the TNM-287 regression shape)", () => {
      const source = `
        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          const proc = await runChildProcess();
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: false,
          };
        }
      `;
      const violations = findAdapterErrorMessageContractViolations(source);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.reason).toMatch(/without errorMessage/);
    });

    it("flags an explicit errorMessage: null beside a real exit code", () => {
      const source = `
        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: null,
          };
        }
      `;
      const violations = findAdapterErrorMessageContractViolations(source);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.reason).toMatch(/literal null/);
    });

    it("accepts a literal exitCode: 0 success return with no errorMessage", () => {
      const source = `
        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          return { exitCode: 0, signal: null, timedOut: false };
        }
      `;
      expect(findAdapterErrorMessageContractViolations(source)).toEqual([]);
    });

    it("accepts an inline ternary tying errorMessage's nullness to the same failure condition", () => {
      const source = `
        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          const proc = await runChildProcess();
          const failed = (proc.exitCode ?? 0) !== 0;
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: false,
            errorMessage: failed ? "it broke" : null,
          };
        }
      `;
      expect(findAdapterErrorMessageContractViolations(source)).toEqual([]);
    });

    it("accepts an early-return guard followed by an unconditional fall-through success return", () => {
      const source = `
        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          const proc = await runChildProcess();
          if ((proc.exitCode ?? 0) !== 0) {
            return {
              exitCode: proc.exitCode,
              signal: proc.signal,
              timedOut: false,
              errorMessage: \`Process exited with code \${proc.exitCode}\`,
            };
          }
          return { exitCode: proc.exitCode, signal: proc.signal, timedOut: false };
        }
      `;
      expect(findAdapterErrorMessageContractViolations(source)).toEqual([]);
    });

    it("ignores unrelated helpers that merely happen to share the exitCode field name", () => {
      const source = `
        function buildLoginResult(input: { proc: RunProcessResult }) {
          return { exitCode: input.proc.exitCode, signal: input.proc.signal, timedOut: false };
        }

        async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
          return { exitCode: 0, signal: null, timedOut: false };
        }
      `;
      expect(findAdapterErrorMessageContractViolations(source)).toEqual([]);
    });
  });
});
