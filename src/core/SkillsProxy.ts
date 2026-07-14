/**
 * SkillsProxy — Anthropic-compatible Hono router for /skills, /skill-versions, /files.
 *
 * Mount at /anthropic to serve:
 *   GET    /anthropic/skills
 *   POST   /anthropic/skills
 *   GET    /anthropic/skills/{skill_id}
 *   DELETE /anthropic/skills/{skill_id}
 *   GET    /anthropic/skills/{skill_id}/versions
 *   POST   /anthropic/skills/{skill_id}/versions
 *   GET    /anthropic/skills/{skill_id}/versions/{version}
 *   DELETE /anthropic/skills/{skill_id}/versions/{version}
 *   GET    /anthropic/skills/{skill_id}/versions/{version}/content
 *   GET    /anthropic/files
 *   POST   /anthropic/files
 *   GET    /anthropic/files/{file_id}
 *   GET    /anthropic/files/{file_id}/content
 *   DELETE /anthropic/files/{file_id}
 *
 * @deprecated Import from "./skills/skillsProxy" directly.
 */
export { SkillsProxy, skillsProxy } from './skills/skillsProxy';
