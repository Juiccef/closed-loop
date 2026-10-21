// Phase 0 spike 3: sequential tools/call round trips against a deployed endpoint.
// Usage: node spikes/latency.mjs <base_url> <token> [n]
const [base, token, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 50);
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_due_checkins', arguments: {} } });
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-03-26' };
const times = [];
for (let i = 0; i < n; i++) {
  const t0 = performance.now();
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
  const json = await res.json();
  const ms = performance.now() - t0;
  if (res.status !== 200 || !json.result?.structuredContent) throw new Error(`call ${i}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  times.push(ms);
}
const sorted = [...times].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
console.log(JSON.stringify({ n, first: Math.round(times[0]), p50: Math.round(pct(50)), p95: Math.round(pct(95)), p99: Math.round(pct(99)), max: Math.round(sorted.at(-1)) }));
