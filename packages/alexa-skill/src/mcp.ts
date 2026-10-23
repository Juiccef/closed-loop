// A small MCP client for the skill: Streamable HTTP, JSON responses, against Closed Loop's stateless server.
// Same wire format as the simulator's McpClient (apps/shared/app.js): initialize, notifications/initialized, tools/call.

export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export interface McpClientOptions {
  /** The server's /mcp URL. */
  url: string;
  /** Bearer token. The static demo token acts for the shared `demo` household. */
  token: string;
  fetch?: typeof fetch;
  /** Per HTTP call. Alexa waits about 8 seconds for the whole response, and a turn can make three calls. */
  timeoutMs?: number;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** The protocol version this client asks for; the server also accepts 2025-03-26. */
export const PROTOCOL_VERSION = '2025-11-25';

export class SkillMcpClient {
  private negotiated: string | null = null;
  private initializing: Promise<void> | null = null;
  private nextId = 1;

  constructor(private readonly opts: McpClientOptions) {}

  private async post(message: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.opts.token}`,
    };
    if (this.negotiated) headers['mcp-protocol-version'] = this.negotiated;
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.opts.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2500),
      });
    } catch (err) {
      throw new McpError(`MCP request failed: ${(err as Error).message}`);
    }
    if (res.status === 202) return { status: 202, body: null };
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new McpError(`MCP HTTP ${res.status}`, res.status);
    const error = (body as { error?: { message?: string } } | null)?.error;
    if (error) throw new McpError(error.message ?? 'MCP error');
    return { status: res.status, body };
  }

  /**
   * Once per Lambda container. The server is stateless (no session id), so the negotiated version is all
   * there is to keep; warm invocations go straight to tools/call.
   */
  private initialize(): Promise<void> {
    this.initializing ??= (async () => {
      const { body } = await this.post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'closed-loop-alexa-skill', version: '0.1.0' } },
      });
      this.negotiated = (body as { result?: { protocolVersion?: string } })?.result?.protocolVersion ?? PROTOCOL_VERSION;
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((err) => {
      this.initializing = null; // try again on the next turn
      throw err;
    });
    return this.initializing;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.initialize();
    const { body } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    const result = (body as { result?: ToolResult } | null)?.result;
    if (!result) throw new McpError('MCP response had no result');
    return result;
  }
}

/** The text a tool result says out loud: structuredContent.say, else the first text block. */
export function sayOf(r: ToolResult): string {
  const say = r.structuredContent?.say;
  return typeof say === 'string' && say ? say : (r.content?.find((c) => c.type === 'text')?.text ?? '');
}
