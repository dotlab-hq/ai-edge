/**
 * pdf-content-conversion.test.ts
 *
 * Tests for Anthropic document block → OpenAI Chat Completions conversion
 * in the claude-adapter's processUserContentBlocks().
 *
 * Covers:
 *   - PDF document blocks → text placeholder (not image_url)
 *   - Text document blocks → decoded inline text
 *   - Image blocks → image_url data URL (unchanged)
 *   - URL-source document blocks → image_url (unchanged)
 *   - Unresolved file references → text fallback
 *   - Other binary documents → image_url data URL (unchanged)
 */
import { expect, test, describe } from 'bun:test';
import { processUserContentBlocks } from '../src/package/claude-adapter/converters/requestContent';
import type { AnthropicContentBlock } from '../src/package/claude-adapter/types/anthropic';

// Helper to create a minimal dedupe context
const emptyDedupe = { idMappings: new Map(), resultIndex: new Map() };

const SAMPLE_PDF_BASE64 = Buffer.from( '%PDF-1.4 fake pdf content for testing' ).toString( 'base64' );
const SAMPLE_TEXT_BASE64 = Buffer.from( 'Hello, this is plain text content.' ).toString( 'base64' );
const SAMPLE_JSON_BASE64 = Buffer.from( JSON.stringify( { key: 'value' } ) ).toString( 'base64' );

// ── PDF Document Block ──────────────────────────────────────────────────

describe( 'PDF document blocks', () => {

    test( 'converts PDF document block to text placeholder (not image_url)', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: SAMPLE_PDF_BASE64,
                },
            },
            { type: 'text', text: 'Summarize this PDF.' },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.toolResults ).toHaveLength( 0 );
        expect( result.userContent ).toHaveLength( 2 );

        // First block should be a text placeholder, NOT image_url
        const pdfPart = result.userContent[0];
        expect( pdfPart ).not.toHaveProperty( 'type', 'image_url' );
        expect( pdfPart ).toHaveProperty( 'type', 'text' );
        expect( ( pdfPart as any ).text ).toContain( 'PDF attachment' );
        expect( ( pdfPart as any ).text ).toContain( 'does not support PDF input' );

        // Second block should be the text prompt unchanged
        expect( result.userContent[1] ).toEqual( { type: 'text', text: 'Summarize this PDF.' } );
    } );

    test( 'handles PDF document block without media_type (defaults to text/plain fallback?)', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    data: SAMPLE_PDF_BASE64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        // Without media_type, it falls through: media_type is undefined → 'text/plain' → isTextType = true
        // So it tries to decode as text. The base64 decodes to '%PDF-1.4 fake...'
        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'text' );
        // The content will be the decoded text since no media_type was set
        const text = ( result.userContent[0] as any ).text;
        expect( text ).toContain( '%PDF-1.4' );
    } );

    test( 'accompanies PDF with a text block asking a question', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: SAMPLE_PDF_BASE64,
                },
            },
            { type: 'text', text: 'What does this document say?' },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent[0] ).toHaveProperty( 'type', 'text' );
        expect( result.userContent[1] ).toEqual( { type: 'text', text: 'What does this document say?' } );
    } );
} );

// ── Text Document Blocks ────────────────────────────────────────────────

describe( 'Text document blocks', () => {

    test( 'converts text/plain document block to inline text', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'text/plain',
                    data: SAMPLE_TEXT_BASE64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toEqual( {
            type: 'text',
            text: 'Hello, this is plain text content.',
        } );
    } );

    test( 'converts application/json document block to inline text', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/json',
                    data: SAMPLE_JSON_BASE64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'text' );
        expect( ( result.userContent[0] as any ).text ).toBe( JSON.stringify( { key: 'value' } ) );
    } );

    test( 'converts text/html document block to inline text', () => {
        const htmlBase64 = Buffer.from( '<html><body>Hello</body></html>' ).toString( 'base64' );
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'text/html',
                    data: htmlBase64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'text' );
        expect( ( result.userContent[0] as any ).text ).toContain( '<html>' );
    } );
} );

// ── Image Blocks (unchanged behavior) ───────────────────────────────────

describe( 'Image blocks', () => {

    test( 'converts base64 image block to image_url data URL', () => {
        const imageBase64 = Buffer.from( 'fake-image-data' ).toString( 'base64' );
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: imageBase64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'image_url' );
        expect( ( result.userContent[0] as any ).image_url.url ).toBe( `data:image/png;base64,${imageBase64}` );
    } );

    test( 'converts URL image block to image_url', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'image',
                source: {
                    type: 'url',
                    url: 'https://example.com/photo.jpg',
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toEqual( {
            type: 'image_url',
            image_url: { url: 'https://example.com/photo.jpg' },
        } );
    } );
} );

// ── Other Binary Document Blocks ────────────────────────────────────────

describe( 'Other binary document blocks', () => {

    test( 'converts word document to image_url data URL (existing fallback)', () => {
        const docBase64 = Buffer.from( 'fake-doc-content' ).toString( 'base64' );
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    data: docBase64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        // Non-PDF binary documents still use the image_url fallback
        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'image_url' );
        expect( ( result.userContent[0] as any ).image_url.url ).toContain( 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' );
    } );

    test( 'converts image/svg+xml to image_url data URL', () => {
        const svgBase64 = Buffer.from( '<svg></svg>' ).toString( 'base64' );
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'image/svg+xml',
                    data: svgBase64,
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'image_url' );
    } );
} );

// ── URL-Source Document Blocks ──────────────────────────────────────────

describe( 'URL-source document blocks', () => {

    test( 'converts URL document to image_url (unchanged)', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'url',
                    url: 'https://example.com/report.pdf',
                },
            },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        expect( result.userContent[0] ).toEqual( {
            type: 'image_url',
            image_url: { url: 'https://example.com/report.pdf' },
        } );
    } );
} );

// ── Unresolved File References ──────────────────────────────────────────

describe( 'Unresolved file references', () => {

    test( 'unresolved file_id gets text fallback', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'file',
                    file_id: 'file_abc123',
                },
            } as AnthropicContentBlock,
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        const part = result.userContent[0];
        expect( part ).toHaveProperty( 'type', 'text' );
        expect( ( part as any ).text ).toContain( 'file_abc123' );
    } );

    test( 'completely unknown source type gets generic fallback', () => {
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'document',
                source: {
                    type: 'unknown_source_type',
                },
            } as any,
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 1 );
        const part = result.userContent[0];
        expect( part ).toHaveProperty( 'type', 'text' );
        expect( ( part as any ).text ).toBe( '[Unresolved document attachment]' );
    } );
} );

// ── Mixed Content ───────────────────────────────────────────────────────

describe( 'Mixed content blocks', () => {

    test( 'handles text + PDF + text combination', () => {
        const blocks: AnthropicContentBlock[] = [
            { type: 'text', text: 'Here is a document:' },
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: SAMPLE_PDF_BASE64,
                },
            },
            { type: 'text', text: 'What do you think?' },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 3 );
        expect( result.userContent[0] ).toEqual( { type: 'text', text: 'Here is a document:' } );
        expect( result.userContent[1] ).toHaveProperty( 'type', 'text' );
        expect( ( result.userContent[1] as any ).text ).toContain( 'PDF attachment' );
        expect( result.userContent[2] ).toEqual( { type: 'text', text: 'What do you think?' } );
    } );

    test( 'handles image + PDF + text combination', () => {
        const imgBase64 = Buffer.from( 'img' ).toString( 'base64' );
        const blocks: AnthropicContentBlock[] = [
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: imgBase64 },
            },
            {
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: SAMPLE_PDF_BASE64,
                },
            },
            { type: 'text', text: 'Analyze both.' },
        ];

        const result = processUserContentBlocks( blocks, emptyDedupe );

        expect( result.userContent ).toHaveLength( 3 );
        expect( result.userContent[0] ).toHaveProperty( 'type', 'image_url' );
        expect( result.userContent[1] ).toHaveProperty( 'type', 'text' );
        expect( ( result.userContent[1] as any ).text ).toContain( 'PDF attachment' );
        expect( result.userContent[2] ).toEqual( { type: 'text', text: 'Analyze both.' } );
    } );
} );
