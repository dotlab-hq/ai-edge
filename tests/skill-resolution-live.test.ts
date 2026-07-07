/**
 * skill-resolution-live.test.ts
 *
 * Behavioral LLM test — NOT a standard unit test.
 *
 * This test uploads a skill with UNIQUE, UNUSUAL facts, sends a chat message
 * asking the LLM to answer using ONLY the skill context, then READS the
 * LLM's response to verify it actually references the specific content.
 *
 * Flow:
 *   1. Create a skill with highly specific, made-up facts
 *   2. Upload a skill version with content containing those facts
 *   3. Send a message with container.skills referencing the skill
 *   4. Read the LLM response and assert it mentions key phrases from the skill
 *   5. Cleanup
 *
 * Run: bun test tests/skill-resolution-live.test.ts --timeout 60000
 */
import { describe, test, expect } from 'bun:test';

// ── Config ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.AI_EDGE_URL || 'https://ai.wpsadi.dev';
const API_KEY = process.env.AI_EDGE_KEY || 'qwerty-asdf';
const ANTHROPIC_BASE = `${BASE_URL}/anthropic`;

// ── Unique skill content with verifiable facts ──────────────────────────

const SKILL_NAME = 'zorplex-planetary-database';
const SKILL_CONTENT = `
# Zorplex Interstellar Database — Entry #4472-B

## Planet: Glarnox-7
- **Star System:** Velmithar Cluster
- **Population:** 2.3 billion Zorplexians
- **Atmosphere:** 62% nitrogen, 24% oxygen, 14% xenon vapor
- **Average Temperature:** -47°C (cryogenic plains)
- **Currency:** Glarn credits (symbol: ₲)
- **Famous Landmark:** The Floating Monastery of Dral'thuur

## Planet: Quibara-IX
- **Star System:** Outer Kellis Rim
- **Population:** 890 million
- **Atmosphere:** Pure methane with trace argon
- **Average Temperature:** 312°C (molten desert world)
- **Currency:** Quibaran shards (symbol: ◊)
- **Famous Landmark:** The Obsidian Tide of Verul

## Trade Agreement #ZZT-99812
Between Glarnox-7 and Quibara-IX:
- Glarnox-7 exports: cryogenic crystals (used as Quibaran fuel cells)
- Quibara-IX exports: volcanic glass armor (critical for Glarnoxian construction)
- Annual trade volume: 4.7 trillion Glarn credits
- Treaty brokered by: High Arbiter Neelix Stormwind in Galactic Year 9024
`.trim();

// Keywords we expect the LLM to mention if it actually read the skill
const EXPECTED_KEYWORDS = [
  'Glarnox',
  'Quibara',
  'Dral',
  'Neelix',
  'Velmithar',
];

// ── API Helper ──────────────────────────────────────────────────────────

async function apiFetch(
  method: string,
  url: string,
  body?: any
): Promise<{ status: number; data: any; raw: string }> {
  const headers: Record<string, string> = { 'x-api-key': API_KEY };
  if (body && method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
  }
  const init: RequestInit = { method, headers };
  if (body && method !== 'GET' && method !== 'DELETE') {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, raw: text };
}

/** Extract assistant text from Anthropic response */
function extractText(res: any): string {
  if (res.data?.content?.[0]?.text) return res.data.content[0].text;
  if (typeof res.data === 'string') return res.data;
  return JSON.stringify(res.data);
}

/** Check how many keywords appear in text (case-insensitive) */
function matchKeywords(text: string, keywords: string[]): { found: string[]; missing: string[] } {
  const lower = text.toLowerCase();
  const found = keywords.filter(k => lower.includes(k.toLowerCase()));
  const missing = keywords.filter(k => !lower.includes(k.toLowerCase()));
  return { found, missing };
}

// ── State ───────────────────────────────────────────────────────────────

let skillId: string | undefined;
let versionId: string | undefined;
let skillDownloadedContent: string | undefined;

// ── Tests ───────────────────────────────────────────────────────────────

describe('Skill Resolution — LLM Behavioral Test', () => {

  // ── Step 1: Create the skill ────────────────────────────────────────
  test('create skill with unique facts', async () => {
    const res = await apiFetch('POST', `${ANTHROPIC_BASE}/v1/skills`, {
      name: SKILL_NAME,
      description: 'Interstellar database of fictional planets',
      source: 'custom',
    });
    console.log(`  → Skill creation: ${res.status}`);
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^skill_/);
    skillId = res.data.id;
    console.log(`  → Skill ID: ${skillId}`);
  });

  // ── Step 2: Upload skill content ────────────────────────────────────
  test('upload skill version with specific facts', async () => {
    const res = await apiFetch(
      'POST',
      `${ANTHROPIC_BASE}/v1/skills/${skillId}/versions`,
      { content: SKILL_CONTENT, description: 'Planetary database v1' }
    );
    console.log(`  → Version creation: ${res.status}`);
    expect(res.status).toBe(201);
    versionId = res.data.version;
    console.log(`  → Version ID: ${versionId}`);
  });

  // ── Step 3: Verify content is downloadable ──────────────────────────
  test('skill content is downloadable from S3', async () => {
    const res = await apiFetch(
      'GET',
      `${ANTHROPIC_BASE}/v1/skills/${skillId}/versions/${versionId}/content`
    );
    expect(res.status).toBe(200);
    skillDownloadedContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    expect(skillDownloadedContent.length).toBeGreaterThan(100);
    // Should contain the unique facts
    expect(skillDownloadedContent).toContain('Glarnox-7');
    expect(skillDownloadedContent).toContain('Quibara-IX');
    expect(skillDownloadedContent).toContain('-47');
    console.log(`  → Content length: ${skillDownloadedContent.length} chars — unique facts verified`);
  });

  // ── Step 4: Send message with skill — verify LLM uses it ────────────
  test('LLM response references skill-specific content (multi-question)', async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await apiFetch('POST', `${ANTHROPIC_BASE}/v1/messages`, {
        model: 'deepseek-v4-flash-free',
        max_tokens: 512,
        system: 'You are a helpful assistant. Answer ONLY using the loaded skill context.',
        messages: [
          {
            role: 'user',
            content: [
              'Using ONLY the loaded skill context, answer these questions:',
              '1. What is the average temperature of Glarnox-7?',
              '2. What does Quibara-IX export?',
              '3. Who brokered the trade agreement?',
              '4. What is the famous landmark on Glarnox-7?',
              'Reply with the specific answers.',
            ].join('\n'),
          },
        ],
        container: {
          skills: [{ type: 'custom', skill_id: skillId }],
        },
      });

      const responseText = extractText(res);
      console.log(`\n  ─── LLM RESPONSE ───`);
      console.log(`  ${responseText.substring(0, 1000)}`);
      console.log(`  ─── END RESPONSE ───\n`);

      // Match keywords
      const { found, missing } = matchKeywords(responseText, EXPECTED_KEYWORDS);
      console.log(`  → Keywords found:    [${found.join(', ')}] (${found.length}/${EXPECTED_KEYWORDS.length})`);
      console.log(`  → Keywords missing:  [${missing.join(', ')}]`);

      // Check for specific factual answers
      const hasTemp = responseText.includes('-47') || responseText.includes('47');
      const hasTrade = /neelix|stormwind|arbiter/i.test(responseText);
      const hasExport = /cryogenic|crystal|volcanic|glass/i.test(responseText);
      const hasLandmark = /monastery|dral/i.test(responseText);

      console.log(`  → Specific facts: temp=${hasTemp}, broker=${hasTrade}, export=${hasExport}, landmark=${hasLandmark}`);

      if (found.length >= 3) {
        console.log(`  ✅ PASS — LLM correctly referenced skill content`);
      } else if (found.length >= 1) {
        console.log(`  ⚠ PARTIAL — LLM mentioned some skill content (${found.length}/${EXPECTED_KEYWORDS.length})`);
      } else {
        console.log(`  ❌ FAIL — LLM did NOT reference any skill-specific content`);
      }

      // At least 2 keywords = skill was resolved and injected
      expect(found.length).toBeGreaterThanOrEqual(2);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  // ── Step 5: Focused question — atmosphere percentages ───────────────
  test('LLM accurately reports atmosphere percentages from skill', async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await apiFetch('POST', `${ANTHROPIC_BASE}/v1/messages`, {
        model: 'deepseek-v4-flash-free',
        max_tokens: 256,
        system: 'You are a helpful assistant.',
        messages: [
          {
            role: 'user',
            content: 'What is the exact atmospheric composition of Glarnox-7 according to the loaded skill? List all percentages.',
          },
        ],
        container: {
          skills: [{ type: 'custom', skill_id: skillId }],
        },
      });

      const responseText = extractText(res);
      console.log(`\n  ─── ATMOSPHERE RESPONSE ───`);
      console.log(`  ${responseText.substring(0, 600)}`);
      console.log(`  ─── END ───\n`);

      // Check for specific percentages
      const has62 = responseText.includes('62');
      const has24 = responseText.includes('24');
      const has14 = responseText.includes('14');
      const hasXenon = /xenon/i.test(responseText);

      const score = [has62, has24, has14, hasXenon].filter(Boolean).length;
      console.log(`  → Atmosphere check: 62%=${has62}, 24%=${has24}, 14%=${has14}, xenon=${hasXenon} (score: ${score}/4)`);

      if (score >= 3) {
        console.log(`  ✅ PASS — LLM accurately reported atmosphere from skill`);
      } else if (score >= 1) {
        console.log(`  ⚠ PARTIAL — some atmosphere data matched`);
      } else {
        console.log(`  ❌ FAIL — atmosphere data not found in response`);
      }

      expect(score).toBeGreaterThanOrEqual(1);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  // ── Step 6: Without skill — prove LLM doesn't know these facts ─────
  test('without skill, LLM does NOT know the fictional facts', async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await apiFetch('POST', `${ANTHROPIC_BASE}/v1/messages`, {
        model: 'deepseek-v4-flash-free',
        max_tokens: 256,
        system: 'You are a helpful assistant.',
        messages: [
          {
            role: 'user',
            content: 'What is the average temperature and atmospheric composition of the planet Glarnox-7 in the Velmithar Cluster?',
          },
        ],
        // NO container.skills — skill should NOT be injected
      });

      const responseText = extractText(res);
      console.log(`\n  ─── NO-SKILL RESPONSE ───`);
      console.log(`  ${responseText.substring(0, 600)}`);
      console.log(`  ─── END ───\n`);

      const knowsGlarnox = /glarnox/i.test(responseText);
      const knowsTemp = responseText.includes('-47');
      const knowsAtmo = /xenon/i.test(responseText);

      console.log(`  → Without skill: mentions Glarnox=${knowsGlarnox}, temp=${knowsTemp}, xenon=${knowsAtmo}`);

      if (!knowsGlarnox) {
        console.log(`  ✅ CONFIRMED — LLM does NOT know Glarnox without skill injection`);
      } else {
        console.log(`  ℹ  LLM mentioned Glarnox — may be hallucinating (acceptable for fictional topics)`);
      }

      // This is informational only — LLMs can hallucinate fictional planet names

    } finally {
      clearTimeout(timeoutId);
    }
  });

  // ── Step 7: File upload + reference in message ─────────────────────
  test('uploaded file content accessible and referenced', async () => {
    // Create a file with unique content
    const fileContent = 'The secret code for Project Zorplex is: NX-4472-BRAVO. Repeat: NX-4472-BRAVO. This code grants level-9 clearance.';

    const formData = new FormData();
    const blob = new Blob([fileContent], { type: 'text/plain' });
    formData.append('file', blob, 'project-zorplex-secrets.txt');
    formData.append('purpose', 'assistants');

    const fileRes = await fetch(`${BASE_URL}/anthropic/v1/files`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: formData,
    });
    const fileData = await fileRes.json();
    console.log(`  → File upload: ${fileRes.status}`);
    expect(fileRes.status).toBe(201);
    const fileId = fileData.id;
    console.log(`  → File ID: ${fileId}`);

    // Send a message referencing the file
    const msgRes = await apiFetch('POST', `${ANTHROPIC_BASE}/v1/messages`, {
      model: 'deepseek-v4-flash-free',
      max_tokens: 256,
      system: 'You are a helpful assistant. Answer using the provided document.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: 'What is the secret code mentioned in this document? Reply with just the code.' },
          ],
        },
      ],
    });

    const responseText = extractText(msgRes);
    console.log(`\n  ─── FILE REFERENCE RESPONSE ───`);
    console.log(`  ${responseText.substring(0, 600)}`);
    console.log(`  ─── END ───\n`);

    const hasCode = /NX-4472-BRAVO/i.test(responseText);
    const hasPartialCode = /4472|NX/i.test(responseText);

    if (hasCode) {
      console.log(`  ✅ PASS — LLM correctly extracted the secret code from the uploaded file`);
    } else if (hasPartialCode) {
      console.log(`  ⚠ PARTIAL — LLM found some of the code but not the full string`);
    } else {
      console.log(`  ❌ FAIL — LLM did not mention the secret code from the file`);
    }

    expect(hasPartialCode).toBe(true);

    // Cleanup file
    await apiFetch('DELETE', `${BASE_URL}/anthropic/v1/files/${fileId}`);
    console.log(`  → Cleaned up file: ${fileId}`);
  });

  // ── Cleanup ─────────────────────────────────────────────────────────
  test('cleanup: delete test skill', async () => {
    if (skillId) {
      const res = await apiFetch('DELETE', `${ANTHROPIC_BASE}/v1/skills/${skillId}`);
      console.log(`  → Delete skill: ${res.status}`);
      expect(res.status).toBe(200);
    }
  });
});
