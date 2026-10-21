#!/usr/bin/env bash
# Phase 0 spike 2: wire-level handshake checks with raw curl.
# Usage: spikes/handshake.sh [base_url] [token]
set -u
BASE="${1:-http://localhost:8787}"
TOKEN="${2:-spike-token}"
URL="$BASE/mcp"
PASS=0; FAIL=0

check() { # name, condition-result
  if [ "$2" = "0" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi
}
post() { # body, extra curl args...
  local body="$1"; shift
  curl -s -o /tmp/cl_body -w '%{http_code}' -X POST "$URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -H "authorization: Bearer $TOKEN" "$@" -d "$body"
}

init() { echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$1\",\"capabilities\":{\"roots\":{\"listChanged\":true}},\"clientInfo\":{\"name\":\"Alexa+ MCP Client\",\"version\":\"1.0.0\"}}}"; }

for v in 2025-03-26 2025-11-25; do
  code=$(post "$(init $v)")
  got=$(node -e "const b=require('fs').readFileSync('/tmp/cl_body','utf8');console.log(JSON.parse(b).result.protocolVersion)" 2>/dev/null)
  sid=$(curl -s -D - -o /dev/null -X POST "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $TOKEN" -d "$(init $v)" | grep -i '^mcp-session-id' || true)
  [ "$code" = "200" ] && [ "$got" = "$v" ] && [ -z "$sid" ]; check "initialize $v -> 200, negotiates $v (got $got), no Mcp-Session-Id" $?
done

# Accept header missing entirely (Alexa+ client headers are undocumented)
code=$(curl -s -o /tmp/cl_body -w '%{http_code}' -X POST "$URL" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$(init 2025-03-26)")
[ "$code" = "200" ]; check "initialize with no Accept header -> 200 (got $code)" $?

code=$(post '{"jsonrpc":"2.0","method":"notifications/initialized"}' -H 'mcp-protocol-version: 2025-03-26')
[ "$code" = "202" ]; check "notifications/initialized -> 202 (got $code)" $?

code=$(post '{"jsonrpc":"2.0","id":2,"method":"ping"}' -H 'mcp-protocol-version: 2025-11-25')
[ "$code" = "200" ]; check "ping -> 200 (got $code)" $?

post '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' -H 'mcp-protocol-version: 2025-11-25' >/dev/null; cp /tmp/cl_body /tmp/cl_list1
post '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' -H 'mcp-protocol-version: 2025-03-26' >/dev/null; cp /tmp/cl_body /tmp/cl_list2
cmp -s /tmp/cl_list1 /tmp/cl_list2; check "tools/list byte-identical across calls and versions" $?
names=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/cl_list1','utf8')).result.tools.map(t=>t.name).join(','))")
[ "$names" = "get_due_checkins,record_response,defer_checkin,get_my_status,pause_checkins" ]; check "tools/list returns the five tools in order ($names)" $?

post '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_due_checkins","arguments":{}}}' -H 'mcp-protocol-version: 2025-11-25' >/dev/null
node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/cl_body','utf8')).result; process.exit(r.structuredContent && r.content[0].type==='text' && r.content[0].text.length>0 ? 0 : 1)"
check "tools/call returns structuredContent + text fallback" $?

post '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"record_response","arguments":{"occurrenceId":"OCC#x","response":"confirmed"}}}' >/dev/null
node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/cl_body','utf8')); process.exit((b.error) || (b.result && b.result.isError) ? 0 : 1)"
check "enum violation (response=confirmed) rejected" $?

long=$(node -e "console.log('a'.repeat(201))")
post "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"record_response\",\"arguments\":{\"occurrenceId\":\"OCC#x\",\"response\":\"done\",\"utterance\":\"$long\"}}}" >/dev/null
node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/cl_body','utf8')); process.exit((b.error) || (b.result && b.result.isError) ? 0 : 1)"
check "oversize utterance (201 chars) rejected" $?

code=$(post "$(init 2025-11-25)" -H 'origin: https://evil.example')
[ "$code" = "403" ]; check "bad Origin -> 403 (got $code)" $?

code=$(post "$(init 2025-11-25)" -H 'origin: http://localhost:5173')
[ "$code" = "200" ]; check "allowed Origin -> 200 (got $code)" $?

code=$(curl -s -o /dev/null -D /tmp/cl_hdr -w '%{http_code}' -X POST "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$(init 2025-11-25)")
! grep -qi '^www-authenticate' /tmp/cl_hdr; nohdr=$?
[ "$code" = "401" ] && [ "$nohdr" = "0" ]; check "no token -> 401 without WWW-Authenticate (got $code)" $?

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer wrong' -d "$(init 2025-11-25)")
[ "$code" = "401" ]; check "wrong token -> 401 (got $code)" $?

code=$(curl -s -o /tmp/cl_body -w '%{http_code}' "$BASE/.well-known/oauth-protected-resource")
node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/cl_body','utf8')); process.exit(b.resource && b.authorization_servers ? 0 : 1)"; ok=$?
[ "$code" = "200" ] && [ "$ok" = "0" ]; check "PRM document served (RFC 9728)" $?

code=$(curl -s -o /tmp/cl_body -w '%{http_code}' "$BASE/.well-known/oauth-authorization-server")
node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/cl_body','utf8')); process.exit(b.code_challenge_methods_supported.includes('S256') && b.grant_types_supported.includes('client_credentials') ? 0 : 1)"; ok=$?
[ "$code" = "200" ] && [ "$ok" = "0" ]; check "AS metadata stub advertises S256 + client_credentials" $?

code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" -H "authorization: Bearer $TOKEN" -H 'accept: text/event-stream')
[ "$code" = "405" ]; check "GET /mcp -> 405 (got $code)" $?

code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$URL" -H 'origin: http://localhost:5173' -H 'access-control-request-method: POST')
[ "$code" = "204" ]; check "CORS preflight from simulator origin -> 204 (got $code)" $?

echo "---"; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
