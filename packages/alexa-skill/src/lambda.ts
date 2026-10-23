// AWS entry point for the Alexa skill. Configuration comes from the SAM template (infra/template.yaml),
// which reads .env through scripts/deploy.sh; nothing secret is in the code.
import { DEMO_TIMEZONE } from '@closed-loop/core';
import type { RequestEnvelope } from 'ask-sdk-model';
import { SkillMcpClient } from './mcp';
import { createSkill } from './skill';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const skill = createSkill({
  skillId: env('ALEXA_SKILL_ID'),
  mcp: new SkillMcpClient({ url: env('MCP_URL'), token: env('MCP_BEARER_TOKEN') }),
  timezone: process.env.HOUSEHOLD_TIMEZONE || DEMO_TIMEZONE,
});

export const lambdaHandler = (event: RequestEnvelope, context: unknown) => skill.invoke(event, context);
