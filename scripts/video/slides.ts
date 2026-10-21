// Static slides for scene 7 of the demo video.

// Architecture slide for scene 7 (on-brand, loads instantly; Bedrock shown as wired in but awaiting quota).
const box = (x: number, y: number, w: number, title: string, sub: string, tone = 'ink') =>
  `<g transform="translate(${x},${y})"><rect width="${w}" height="74" rx="14" fill="#ffffff" stroke="${tone === 'aws' ? '#0972d3' : '#c9ced5'}" stroke-width="${tone === 'aws' ? 2.5 : 1.5}" ${tone === 'dashed' ? 'stroke-dasharray="7 6"' : ''}/><text x="18" y="31" class="t">${title}</text><text x="18" y="55" class="s">${sub}</text></g>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#5b6573" stroke-width="2" marker-end="url(#a)" ${dashed ? 'stroke-dasharray="6 6"' : ''}/>`;
export const architectureHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;background:#f2f3f5;color:#0f141a;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center}
h1{font-weight:700;font-size:40px;letter-spacing:-.02em;margin:0 0 6px}
p{margin:0 0 18px;color:#5b6573;font-size:18px}
.t{font:600 19px -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;fill:#0f141a}.s{font:15px -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;fill:#5b6573}
</style></head><body><div><h1>How it runs</h1><p>One SAM template. Real MCP over Streamable HTTP. AWS services outlined in blue.</p>
<svg width="1270" height="520" viewBox="0 0 1270 520"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="#5b6573"/></marker></defs>
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
<path d="M1200 337 H1245 V57 H1208" fill="none" stroke="#5b6573" stroke-width="2" marker-end="url(#a)"/>
${arrow(740, 210, 848, 455, true)}
</svg></div></body></html>`;

export const endCardHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#f2f3f5;color:#0f141a;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased}
main{text-align:center;max-width:980px;padding:0 40px}svg{width:96px;height:96px}
circle{fill:none;stroke:#037f0c;stroke-width:5;stroke-linecap:round}
h1{font-size:76px;font-weight:700;letter-spacing:-.03em;margin:18px 0 6px}
.lede{font-size:30px;color:#5b6573;margin:0 0 30px}
.url{font-size:28px;font-weight:600;color:#065bb0;margin:0 0 34px}.n{font-size:17px;color:#5b6573;margin:6px 0}
</style></head><body><main><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="14"/></svg><h1>Closed Loop</h1>
<p class="lede">Daily check-ins that close the loop, for people living alone and the families who look after them.</p><p class="url">github.com/Juiccef/closed-loop</p>
<p class="n">Simulated Alexa+ client. Not Amazon software. The MCP server is real.</p>
<p class="n">Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.</p></main></body></html>`;


// Scene 1: the problem, each number with its source (verified in docs/impact.md). Steps are revealed by the recorder.
const stat = (n: number, big: string, label: string, source: string) =>
  `<div class="stat" data-n="${n}"><p class="big">${big}</p><p class="label">${label}</p><p class="src">${source}</p></div>`;
export const problemHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;background:#0f141a;color:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center}
main{width:1240px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:64px 96px}
.stat{opacity:0;transform:translateY(14px);transition:opacity .7s cubic-bezier(.2,.8,.2,1),transform .7s cubic-bezier(.2,.8,.2,1)}
body[data-step="1"] .stat[data-n="1"],body[data-step="2"] .stat:is([data-n="1"],[data-n="2"]),body[data-step="3"] .stat:not([data-n="4"]),body[data-step="4"] .stat{opacity:1;transform:none}
.big{font-size:76px;font-weight:700;letter-spacing:-.03em;line-height:1;margin:0 0 14px}
.label{font-size:26px;line-height:1.3;color:#d5dae1;margin:0 0 12px;max-width:520px}
.src{font-size:16px;color:#8d99a8;margin:0}
.stat[data-n="4"] .big{color:#7ab8f3}
</style></head><body><main><div class="grid">
${stat(1, '7.4 million', 'Americans 65 and older are living with Alzheimer&rsquo;s.', 'Alzheimer&rsquo;s Association, 2026 Facts and Figures')}
${stat(2, '1 in 4', 'older Americans with dementia or mild cognitive impairment lives alone.', 'UCSF, JAMA Network Open, 2023')}
${stat(3, 'Nearly 13 million', 'family members and friends give unpaid dementia care.', 'Alzheimer&rsquo;s Association, 2026 Facts and Figures')}
${stat(4, 'Alexa Together', 'Amazon&rsquo;s remote caregiving service is no longer available.', 'Amazon, update of May 21, 2025')}
</div></main></body></html>`;

// Scene 9: the Agent Skill, shown from the real SKILL.md.
export const skillHtml = (markdown: string) => {
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const lines = markdown.split('\n');
  const pick = [...lines.slice(0, 4), '', ...lines.slice(lines.findIndex((l) => l.startsWith('## Words you never use')), lines.findIndex((l) => l.startsWith('## Status and pausing')))];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;background:#f2f3f5;color:#0f141a;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center}
.doc{width:1180px;background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(15,20,26,.05),0 2px 12px -2px rgba(15,20,26,.08);overflow:hidden}
.bar{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid #e3e6ea;font-size:18px;font-weight:600}
.bar span{font-weight:400;color:#5b6573}
pre{margin:0;padding:24px 28px;font:18px/1.6 ui-monospace,'SF Mono',Menlo,monospace;white-space:pre-wrap;color:#1f2a37}
</style></head><body><div class="doc"><div class="bar">Agent Skill <span>skills/closed-loop-checkins/SKILL.md</span></div><pre>${esc(pick.join('\n').trim())}</pre></div></body></html>`;
};
