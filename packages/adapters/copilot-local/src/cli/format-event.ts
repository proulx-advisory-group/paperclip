import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data);

  // session.tools_updated → model initialization
  if (type === "session.tools_updated" && data) {
    const model = typeof data.model === "string" ? data.model : "unknown";
    console.log(pc.blue(`Copilot initialized (model: ${model})`));
    return;
  }

  // assistant.message → complete assistant response
  if (type === "assistant.message" && data) {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) console.log(pc.green(`assistant: ${content}`));
    return;
  }

  // assistant.tool_request → tool call
  if (type === "assistant.tool_request" && data) {
    const name = typeof data.name === "string" ? data.name : "unknown";
    console.log(pc.yellow(`tool_call: ${name}`));
    if (data.parameters !== undefined) {
      console.log(pc.gray(JSON.stringify(data.parameters, null, 2)));
    }
    return;
  }

  // tool.result → tool execution result
  if (type === "tool.result" && data) {
    const name = typeof data.name === "string" ? data.name : "";
    const isError = data.isError === true;
    if (isError) {
      console.log(pc.red(`tool_error${name ? `: ${name}` : ""}`));
    } else if (debug) {
      console.log(pc.gray(`tool_result${name ? `: ${name}` : ""}`));
    }
    return;
  }

  // result → final run summary
  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premiumRequests = Number(usage.premiumRequests ?? 0);
    const sessionId =
      typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const exitCode = Number(parsed.exitCode ?? 0);
    const isError = exitCode !== 0;

    if (isError) {
      console.log(pc.red(`copilot_result: exit_code=${exitCode}`));
    }
    if (sessionId && debug) {
      console.log(pc.gray(`session: ${sessionId}`));
    }
    console.log(
      pc.blue(
        `premium_requests: ${Number.isFinite(premiumRequests) ? premiumRequests : 0}`,
      ),
    );
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
