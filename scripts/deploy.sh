#!/usr/bin/env bash
# Builds and deploys the stack. Reads parameters from .env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Copy .env.example to .env and fill it in first." >&2; exit 1; }
set -a; source .env; set +a
for v in ADMIN_TOKEN MCP_BEARER_TOKEN ACK_LINK_SECRET SES_SENDER SEED_L1_EMAIL SEED_L2_EMAIL OAUTH_SIGNING_SECRET ALEXA_CLIENT_SECRET; do
  [ -n "${!v:-}" ] || { echo "Missing $v in .env" >&2; exit 1; }
done
npm run build
EXTRA=()
[ -n "${BEDROCK_MODEL_ID:-}" ] && EXTRA+=("BedrockModelId=$BEDROCK_MODEL_ID")
[ -n "${ALEXA_REDIRECT_URIS:-}" ] && EXTRA+=("AlexaRedirectUris=$ALEXA_REDIRECT_URIS")
sam deploy -t infra/template.yaml \
  --stack-name "${STACK_NAME:-closed-loop}" \
  --region "${AWS_REGION:-us-east-1}" \
  --resolve-s3 --capabilities CAPABILITY_IAM \
  --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides \
    "AdminToken=$ADMIN_TOKEN" "McpBearerToken=$MCP_BEARER_TOKEN" "AckLinkSecret=$ACK_LINK_SECRET" \
    "SesSender=$SES_SENDER" "SeedL1Email=$SEED_L1_EMAIL" "SeedL2Email=$SEED_L2_EMAIL" \
    "OAuthSigningSecret=$OAUTH_SIGNING_SECRET" "AlexaClientSecret=$ALEXA_CLIENT_SECRET" \
    ${EXTRA[@]+"${EXTRA[@]}"}
aws cloudformation describe-stacks --stack-name "${STACK_NAME:-closed-loop}" --region "${AWS_REGION:-us-east-1}" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
