/**
 * Common types for Skills, Skill Versions, and Files.
 * These types support both Anthropic and OpenAI format cross-compatibility.
 */

// ─── Skills ──────────────────────────────────────────────

export interface SkillRecord {
  /** MongoDB _id */
  _id?: string;
  /** Unique identifier for the skill */
  id: string;
  /** ISO 8601 / Unix timestamp of creation */
  created_at: string;
  /** Anthropic: display_title (human-readable label) */
  display_title: string;
  /** OpenAI: name of the skill */
  name: string;
  /** Description extracted from SKILL.md */
  description: string;
  /** Latest version identifier */
  latest_version: string;
  /** Source: "custom" | "anthropic" | "openai" */
  source: string;
  /** OpenAI: default_version identifier */
  default_version: string;
  /** Internal flags for format tracking */
  _formats: ('anthropic' | 'openai')[];
}

export interface SkillVersionRecord {
  _id?: string;
  /** Unique identifier for the skill version */
  id: string;
  /** Unix epoch timestamp version string */
  version: string;
  /** ISO 8601 timestamp of creation */
  created_at: string;
  /** Description extracted from SKILL.md */
  description: string;
  /** Top-level directory name extracted from uploaded files */
  directory: string;
  /** Human-readable name extracted from SKILL.md */
  name: string;
  /** Parent skill ID */
  skill_id: string;
  /** Object type - always "skill_version" */
  type: 'skill_version';
  /** S3 key for the version content (zip/archive) */
  _s3Key: string;
  /** Content size in bytes */
  _contentSize: number;
}

// ─── Files ───────────────────────────────────────────────

export interface FileRecord {
  _id?: string;
  /** Unique identifier for the file */
  id: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  mime_type: string;
  /** File size in bytes */
  size_bytes: number;
  /** Purpose: "assistants" | "batch" | "fine-tune" | "user_data" | etc. */
  purpose: string;
  /** Unix timestamp (seconds) for creation */
  created_at: number;
  /** Object type - always "file" */
  object: 'file';
  /** Status: "uploaded" | "processed" | "error" */
  status: 'uploaded' | 'processed' | 'error';
  /** S3 key for the file content */
  _s3Key: string;
  /** Optional scope ID for filtering */
  scope_id?: string;
  /**
   * Whether this file is downloadable / resolvable in inference.
   * false  = user upload (opaque, not injected into prompts)
   * true   = skill/code-generated file (resolved inline by SkillResolver)
   */
  downloadable?: boolean;
}

// ─── Pagination ──────────────────────────────────────────

export interface AnthropicPageResponse<T> {
  data: T[];
  has_more: boolean;
  next_page?: string;
}

export interface OpenAIListResponse<T> {
  object: 'list';
  data: T[];
}

// ─── Storage Config ──────────────────────────────────────

export interface StorageConfig {
  mongo_uri: string;
  s3: {
    endpoint: string;
    access_key: string;
    secret_key: string;
    bucket: string;
    path_style: boolean;
  };
}

// ─── Helper: ID generation ───────────────────────────────

let idCounter = 0;

export function generateSkillId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const cnt = (idCounter++).toString(36);
  return `skill_${ts}${rand}${cnt}`;
}

export function generateSkillVersionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const cnt = (idCounter++).toString(36);
  return `skillver_${ts}${rand}${cnt}`;
}

export function generateFileVersion(): string {
  return Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

export function generateFileId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const cnt = (idCounter++).toString(36);
  return `file_${ts}${rand}${cnt}`;
}

export function encodePageToken(cursor: string): string {
  return Buffer.from(cursor, 'utf-8').toString('base64url');
}

export function decodePageToken(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf-8');
}
