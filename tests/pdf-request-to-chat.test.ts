/**
 * pdf-request-to-chat.test.ts
 *
 * Tests for Responses API → Chat Completions conversion in requestToChat.ts.
 *
 * Covers:
 *   - input_file / file / document content types → text placeholder
 *   - input_text → unchanged
 *   - input_image → unchanged
 *   - Mixed content with files
 */
import { expect, test, describe } from 'bun:test';
import { convertResponsesRequestToChat } from '../src/core/responses/requestToChat';

// ── File/Document Content Types ─────────────────────────────────────────

describe( 'File and document content in Responses input', () => {

    test( 'input_file in content array gets text placeholder (text-only mode)', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Summarize this file:' },
                        { type: 'input_file', file_id: 'file_abc123' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as string;

        // No images → text-only mode: content is a joined string
        expect( typeof content ).toBe( 'string' );
        expect( content ).toContain( 'Summarize this file:' );
        expect( content ).toContain( 'File:' );
        expect( content ).toContain( 'file_abc123' );
    } );

    test( 'file in content array gets text placeholder (text-only mode)', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Process this:' },
                        { type: 'file', file_id: 'file_xyz789' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as string;

        // No images → text-only mode: content is a joined string
        expect( typeof content ).toBe( 'string' );
        expect( content ).toContain( 'Process this:' );
        expect( content ).toContain( 'File:' );
        expect( content ).toContain( 'file_xyz789' );
    } );

    test( 'document in content array gets text placeholder', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Read this doc:' },
                        { type: 'document', id: 'doc_001' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as string;

        expect( typeof content ).toBe( 'string' );
        expect( content ).toContain( 'Read this doc:' );
        expect( content ).toContain( 'doc_001' );
    } );
} );

// ── Input Text (unchanged) ──────────────────────────────────────────────

describe( 'Input text (unchanged)', () => {

    test( 'plain string input stays unchanged', () => {
        const request = {
            model: 'gpt-4',
            input: 'Hello, world!',
        };

        const chat = convertResponsesRequestToChat( request as any );

        expect( chat.messages ).toHaveLength( 1 );
        expect( chat.messages[0].role ).toBe( 'user' );
        expect( chat.messages[0].content ).toBe( 'Hello, world!' );
    } );

    test( 'single input_text block produces flat string', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Just text, no images.' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );

        expect( chat.messages[0].content ).toBe( 'Just text, no images.' );
    } );

    test( 'multiple input_text blocks produce joined string', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Part one.' },
                        { type: 'input_text', text: 'Part two.' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );

        expect( chat.messages[0].content ).toBe( 'Part one.\nPart two.' );
    } );
} );

// ── Input Image (unchanged) ─────────────────────────────────────────────

describe( 'Input image (unchanged)', () => {

    test( 'input_image stays as image_url in multimodal array', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'What is in this image?' },
                        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as Array<Record<string, unknown>>;

        expect( Array.isArray( content ) ).toBe( true );
        expect( content ).toHaveLength( 2 );
        expect( content[0] ).toEqual( { type: 'text', text: 'What is in this image?' } );
        expect( content[1] ).toEqual( {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        } );
    } );
} );

// ── Mixed Content with Images and Files ─────────────────────────────────

describe( 'Mixed content with images and files', () => {

    test( 'image + file in same message: file gets placeholder, image passes through', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Analyze these:' },
                        { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/' },
                        { type: 'input_file', file_id: 'file_report' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as Array<Record<string, unknown>>;

        expect( Array.isArray( content ) ).toBe( true );
        expect( content ).toHaveLength( 3 );
        // Text unchanged
        expect( content[0] ).toEqual( { type: 'text', text: 'Analyze these:' } );
        // Image unchanged
        expect( content[1] ).toHaveProperty( 'type', 'image_url' );
        // File → text placeholder
        expect( content[2] ).toHaveProperty( 'type', 'text' );
        expect( ( content[2] as any ).text ).toContain( 'file_report' );
    } );

    test( 'PDF file reference with text-only content (no images) gets joined placeholder', () => {
        const request = {
            model: 'gpt-4',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Summarize:' },
                        { type: 'document', id: 'doc_pdf_001' },
                        { type: 'input_text', text: 'Be concise.' },
                    ],
                },
            ],
        };

        const chat = convertResponsesRequestToChat( request as any );
        const content = chat.messages[0].content as string;

        expect( typeof content ).toBe( 'string' );
        expect( content ).toContain( 'Summarize:' );
        expect( content ).toContain( 'doc_pdf_001' );
        expect( content ).toContain( 'Be concise.' );
    } );
} );

// ── Instructions (system message) ───────────────────────────────────────

describe( 'Instructions handling', () => {

    test( 'instructions become system message', () => {
        const request = {
            model: 'gpt-4',
            instructions: 'You are a helpful assistant.',
            input: 'Hi!',
        };

        const chat = convertResponsesRequestToChat( request as any );

        expect( chat.messages ).toHaveLength( 2 );
        expect( chat.messages[0] ).toEqual( { role: 'system', content: 'You are a helpful assistant.' } );
        expect( chat.messages[1] ).toEqual( { role: 'user', content: 'Hi!' } );
    } );
} );
