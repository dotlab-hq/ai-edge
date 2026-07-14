/**
 * OpenAISkillsProxy — OpenAI-compatible Hono router for /skills, /files.
 *
 * All responses use OpenAI format (unix timestamps, `object` field,
 * `{ data, has_more, first_id, last_id }` lists).
 *
 * @deprecated Import from "./skills/openaiSkillsProxy" directly.
 */
export { OpenAISkillsProxy, openAISkillsProxy } from './skills/openaiSkillsProxy';
