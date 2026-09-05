import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  inferHeartbeatRunStopReason,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("labels an unrecognized outcome/errorCode pair unclassified rather than guessing adapter_failed (G2)", () => {
    expect(
      inferHeartbeatRunStopReason({
        outcome: "failed",
        errorCode: "some_future_error_code_nobody_has_written_a_branch_for",
        errorMessage: "an error nothing here recognizes",
      }),
    ).toBe("unclassified");
  });

  it("never lets adapter_failed be the taxonomy's fallback return (G2 static check)", () => {
    // The whole SHIP-1350 defect was a fallback that guessed a cause it never
    // observed. A test can only exercise inputs it thinks to try, so this reads
    // the function's own source: whatever the final `return` statement in its
    // body is, it must not be `"adapter_failed"` — that string may only be
    // reached from a branch that positively identified an adapter fault.
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "heartbeat-stop-metadata.ts");
    const source = readFileSync(sourcePath, "utf8");
    const functionStart = source.indexOf("export function inferHeartbeatRunStopReason");
    expect(functionStart).toBeGreaterThanOrEqual(0);
    const signatureEnd = source.indexOf("): HeartbeatRunStopReason {", functionStart);
    expect(signatureEnd).toBeGreaterThan(functionStart);
    const bodyStart = signatureEnd + "): HeartbeatRunStopReason {".length;
    const bodyEnd = source.indexOf("\n}", bodyStart);
    const body = source.slice(bodyStart, bodyEnd);
    const returns = [...body.matchAll(/return\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(returns.length).toBeGreaterThan(0);
    expect(returns.at(-1)).not.toBe("adapter_failed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
