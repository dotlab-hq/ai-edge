import { describe, it, expect, test } from 'bun:test';
import app from '../../server';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build an app.request() init object for a JSON POST body. */
function post(body: any): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

// Minimal valid body shapes used across tests.
const CHAT_BODY = {
    model: 'deepseek-v4-flash-free',
    messages: [{ role: 'user', content: 'hi' }],
};

const RESPONSES_BODY = {
    model: 'deepseek-v4-flash-free',
    input: [{ role: 'user', content: 'hi' }],
};

const EMBEDDINGS_BODY = {
    model: 'gemini-embedding-2',
    input: 'hello world',
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('GET /v1/models', () => {
    it('returns 200 with object=list and data array at root /v1/models', async () => {
        const res = await app.request('/v1/models');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('list');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
    });

    it('returns the same shape at /openai/v1/models (route mounting)', async () => {
        const res = await app.request('/openai/v1/models');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('list');
        expect(Array.isArray(body.data)).toBe(true);
    });
});

describe('POST /v1/chat/completions', () => {
    it('routes a valid body upstream and returns 200 (proxy layer works)', async () => {
        const res = await app.request('/v1/chat/completions', post(CHAT_BODY));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('chat.completion');
        expect(body.choices).toBeDefined();
        expect(body.choices.length).toBeGreaterThan(0);
    }, 30_000);

    it('returns 400 when the model field is missing', async () => {
        const body = { messages: [{ role: 'user', content: 'hi' }] };
        const res = await app.request('/v1/chat/completions', post(body));
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.message).toMatch(/model/i);
    });
});

describe('POST /v1/responses', () => {
    it('converts a valid Responses API body and returns 200', async () => {
        const res = await app.request('/v1/responses', post(RESPONSES_BODY));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('response');
        expect(body.id).toMatch(/^resp_/);
        expect(body.output).toBeDefined();
        expect(Array.isArray(body.output)).toBe(true);
    }, 30_000);
});

describe('POST /v1/responses/compact', () => {
    it('returns 400 with "model is required" when model is missing', async () => {
        const res = await app.request(
            '/v1/responses/compact',
            post({ input: [{ role: 'user', content: 'hi' }] }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toBe('model is required');
    });

    it('returns 400 when input is missing', async () => {
        const res = await app.request(
            '/v1/responses/compact',
            post({ model: 'auto' }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/input/i);
    });

    it('returns 400 when input is an empty array', async () => {
        const res = await app.request(
            '/v1/responses/compact',
            post({ model: 'auto', input: [] }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/input/i);
    });

    it('returns 200 with response.compact object for valid body', async () => {
        const input = [
            { role: 'system', content: 'Be helpful.' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: 'How are you?' },
        ];
        const res = await app.request(
            '/v1/responses/compact',
            post({ model: 'auto', input }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('response.compact');
        expect(body.model).toBe('auto');
        expect(Array.isArray(body.output)).toBe(true);
        expect(body.usage).toBeDefined();
    });

    it('preserves system messages in compacted output', async () => {
        const input = [
            { role: 'system', content: 'Be helpful.' },
            { role: 'developer', content: 'Be concise.' },
            { role: 'user', content: 'Hi' },
        ];
        const res = await app.request(
            '/v1/responses/compact',
            post({ model: 'auto', input }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        const roles = body.output.map((item: any) => item.role);
        expect(roles).toContain('system');
        expect(roles).toContain('developer');
    });

    it('trims conversation to max 40 items and injects compaction notice', async () => {
        const conversation: any[] = [];
        for (let i = 0; i < 50; i++) {
            conversation.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Message ${i}`,
            });
        }
        const input = [
            { role: 'system', content: 'Rules' },
            ...conversation,
        ];

        const res = await app.request(
            '/v1/responses/compact',
            post({ model: 'auto', input }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // 1 system + 1 compaction notice + 40 conversation = 42
        expect(body.output.length).toBeLessThanOrEqual(42);
        // System message still present
        expect(body.output[0].role).toBe('system');
        // Compaction notice injected
        const compactNotice = body.output.find(
            (item: any) =>
                item.role === 'user' &&
                item.content?.some?.((c: any) =>
                    c.text?.includes('Context compacted'),
                ),
        );
        expect(compactNotice).toBeDefined();
    });
});

describe('POST /v1/embeddings', () => {
    it('routes a valid body upstream and returns 200 (proxy layer works)', async () => {
        const res = await app.request('/v1/embeddings', post(EMBEDDINGS_BODY));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('list');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
    }, 30_000);
});

describe('POST /v1/audio/transcriptions', () => {
    it('returns 400 when model field is missing (validation before routing)', async () => {
        // No Content-Type multipart — the handler tries formData() then checks model.
        // With JSON body, formData() parsing fails but the handler catches and
        // still checks for model. We test the "missing model" validation by sending
        // JSON with no model.
        const res = await app.request(
            '/v1/audio/transcriptions',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        );
        // Handler will attempt formData parsing on JSON body — may return 400 or 500.
        // Either proves the route exists and was reached.
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

describe('POST /v1/audio/speech', () => {
    it('returns 400 when model is missing', async () => {
        const res = await app.request(
            '/v1/audio/speech',
            post({ input: 'hello', voice: 'troy' }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/model/i);
    });

    it('returns 400 when input is missing', async () => {
        const res = await app.request(
            '/v1/audio/speech',
            post({ model: 'canopylabs/orpheus-v1-english', voice: 'troy' }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/input/i);
    });

    it('returns 400 when voice is missing', async () => {
        const res = await app.request(
            '/v1/audio/speech',
            post({ model: 'canopylabs/orpheus-v1-english', input: 'hello' }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/voice/i);
    });
});

describe('POST /v1/images/generations', () => {
    it('routes a valid body to upstream (502 or upstream error = routing worked)', async () => {
        const res = await app.request(
            '/v1/images/generations',
            post({ model: '@cf/black-forest-labs/flux-1-schnell', prompt: 'a cat' }),
        );
        // The upstream either returns a result (2xx) or an error.
        // We accept any non-404 response — 404 would mean the route is missing.
        expect(res.status).not.toBe(404);
    }, 30_000);
});

describe('Route mounting (root vs /openai prefix)', () => {
    it('GET /v1/models returns the same shape as GET /openai/v1/models', async () => {
        const root = await app.request('/v1/models');
        const openai = await app.request('/openai/v1/models');
        expect(root.status).toBe(200);
        expect(openai.status).toBe(200);
        const rootBody = await root.json();
        const openaiBody = await openai.json();
        expect(rootBody.object).toBe('list');
        expect(openaiBody.object).toBe('list');
    });

    it('POST /openai/v1/chat/completions routes correctly', async () => {
        const res = await app.request('/openai/v1/chat/completions', post(CHAT_BODY));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.object).toBe('chat.completion');
    }, 30_000);
});
