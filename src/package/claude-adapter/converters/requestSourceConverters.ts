import type { AnthropicContentBlock } from '../types/anthropic';

export function convertImageSourceToOpenAIUrl( source: Extract<AnthropicContentBlock, { type: 'image' }>['source'] ): string | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return source.url;
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        const mediaType = typeof source.media_type === 'string' && source.media_type.length > 0
            ? source.media_type
            : 'image/png';
        return `data:${mediaType};base64,${source.data}`;
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return source.file_id;
    }

    return undefined;
}

export function convertAudioSourceToOpenAIInput( source: Extract<AnthropicContentBlock, { type: 'audio' }>['source'] ): { data?: string; format?: string; url?: string; file_id?: string } | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        return {
            data: source.data,
            format: typeof source.media_type === 'string' ? source.media_type.split( '/' ).pop() : undefined,
        };
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return { url: source.url };
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return { file_id: source.file_id };
    }

    return undefined;
}

export function convertFileSourceToOpenAIFile( source: Extract<AnthropicContentBlock, { type: 'file' }>['source'] ): { file_id?: string; file_data?: string; url?: string; media_type?: string } | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return { file_id: source.file_id };
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        return {
            file_data: source.data,
            media_type: typeof source.media_type === 'string' ? source.media_type : undefined,
        };
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return { url: source.url };
    }

    return undefined;
}
