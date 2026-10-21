# Closed Loop: rules for every session

- Source of truth: BRIEF.md. Do Phase 0 spikes first.
- Pin @modelcontextprotocol/sdk 1.x. Accept initialize versions 2025-03-26 and 2025-11-25. Stateless.
- MCP tool calls: DynamoDB only, p95 < 500 ms. No Bedrock on the hot path.
- Never write "confirmed". Fail closed to unsure / needs_human.
- Keep FRICTION_LOG.md and PRODUCT_FEEDBACK.md updated as you build.
- Label simulated Alexa+ everywhere. Never invent API shapes; verify or mark unverified.

## Learned in Phase 0 (verified)
- 401 responses carry no WWW-Authenticate header by default (Alexa+ auth docs list it as unsupported). PRM is always served at /.well-known/oauth-protected-resource.
- The SDK returns 406 unless Accept lists both application/json and text/event-stream; http.ts fills in a missing Accept because Alexa+ client headers are undocumented.
- Crisis branch: self-harm wording adds the 988 line (Alexa+ policy: redirect crises to emergency services or crisis hotlines).
- Run `spikes/handshake.sh` after any change to packages/mcp-server; it must stay 18/18.
