/**
 * SkillResolver — Inference-layer middleware that detects skill and file references
 * in request bodies, resolves their content from MongoDB/S3, and injects the
 * resolved content before forwarding upstream.
 *
 * The upstream providers do NOT natively support skills or file references.
 * This layer makes it APPEAR as if they do by resolving references inline.
 *
 * @deprecated Import from "./skills/*" directly.
 */
export { initSkillResolver, isSkillResolverReady } from './skills/resolver';
export { resolveAnthropicBody } from './skills/resolveAnthropic';
export { resolveOpenAIBody } from './skills/resolveOpenAI';
