// Static slides for scene 7 of the demo video.

// Architecture slide for scene 7 (on-brand, loads instantly; Bedrock shown as wired in but awaiting quota).
const box = (x: number, y: number, w: number, title: string, sub: string, tone = 'ink') =>
  `<g transform="translate(${x},${y})"><rect width="${w}" height="74" rx="14" fill="${tone === 'dashed' ? '#fffaf0' : '#fffaf0'}" stroke="${tone === 'aws' ? '#b2441f' : '#d8ccb4'}" stroke-width="${tone === 'aws' ? 2.5 : 1.5}" ${tone === 'dashed' ? 'stroke-dasharray="7 6"' : ''}/><text x="18" y="31" class="t">${title}</text><text x="18" y="55" class="s">${sub}</text></g>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#4a5557" stroke-width="2" marker-end="url(#a)" ${dashed ? 'stroke-dasharray="6 6"' : ''}/>`;
export const architectureHtml = `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fraunces:opsz,wght,SOFT@9..144,400..700,50..100&display=swap" rel="stylesheet"><style>
body{margin:0;height:100vh;background:#f5efe3;color:#1f2a2c;font-family:'Atkinson Hyperlegible',sans-serif;display:grid;place-items:center}
h1{font-family:Fraunces,serif;font-variation-settings:'SOFT' 80;font-weight:580;font-size:40px;margin:0 0 6px}
p{margin:0 0 18px;color:#4a5557;font-size:18px}
.t{font:700 19px 'Atkinson Hyperlegible',sans-serif;fill:#1f2a2c}.s{font:15px 'Atkinson Hyperlegible',sans-serif;fill:#4a5557}
.l{font:600 14px 'Atkinson Hyperlegible',sans-serif;fill:#b2441f;letter-spacing:.08em}
</style></head><body><div><h1>How it runs</h1><p>One SAM template. Real MCP over Streamable HTTP. AWS services outlined in terracotta.</p>
<svg width="1270" height="520" viewBox="0 0 1270 520"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="#4a5557"/></marker></defs>
${box(0, 40, 300, 'Simulated Alexa+ client', 'initialize · tools/list · tools/call')}
${box(0, 170, 300, 'Caregiver console', 'check-ins, consent, ledger')}
${box(0, 300, 300, 'MCP Inspector · SDK client', 'independent MCP clients')}
${box(410, 150, 330, 'AWS Lambda (Function URL)', '/mcp · console API · OAuth 2.1', 'aws')}
${box(850, 20, 350, 'Amazon DynamoDB', 'single table · TTL · Streams', 'aws')}
${box(850, 170, 350, 'Amazon EventBridge Scheduler', 'tick every minute', 'aws')}
${box(850, 300, 350, 'Tick Lambda → Amazon SES', 'windows close · family email', 'aws')}
${box(850, 430, 350, 'Amazon Bedrock (Converse)', 'planner + second opinion · quota pending', 'dashed')}
${arrow(300, 77, 408, 175)}${arrow(300, 207, 408, 190)}${arrow(300, 337, 408, 205)}
${arrow(740, 175, 848, 70)}${arrow(1025, 244, 1025, 298)}
<path d="M1200 337 H1245 V57 H1208" fill="none" stroke="#4a5557" stroke-width="2" marker-end="url(#a)"/>
${arrow(740, 210, 848, 455, true)}
</svg></div></body></html>`;

export const endCardHtml = `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Fraunces:opsz,wght,SOFT@9..144,400..700,50..100&display=swap" rel="stylesheet"><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#f5efe3;color:#1f2a2c;font-family:'Atkinson Hyperlegible',sans-serif}
main{text-align:center;max-width:980px;padding:0 40px}svg{width:96px;height:96px}
circle{fill:none;stroke:#3f6b4f;stroke-width:6;stroke-linecap:round}
h1{font-family:Fraunces,serif;font-variation-settings:'SOFT' 80;font-size:76px;margin:18px 0 6px;font-weight:580}
.lede{font-family:Fraunces,serif;font-size:30px;color:#4a5557;margin:0 0 30px}
.url{font-size:28px;font-weight:700;margin:0 0 34px}.n{font-size:17px;color:#4a5557;margin:6px 0}
</style></head><body><main><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="14"/></svg><h1>Closed Loop</h1>
<p class="lede">Daily check-ins that close the loop.</p><p class="url">github.com/Juiccef/closed-loop</p>
<p class="n">Simulated Alexa+ client. Not Amazon software. The MCP server is real.</p>
<p class="n">Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.</p></main></body></html>`;

