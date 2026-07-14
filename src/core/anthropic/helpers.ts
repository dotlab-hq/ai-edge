import { stripFreeModifier } from '@/utils/modelIds';

export function isAutoModel( modelName: string ): boolean {
    return stripFreeModifier( modelName ).normalizedId === 'auto';
}

export function configHasModel( config: any, modelName: string ): boolean {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    return config.models.some( ( m: any ) => {
        const candidate = typeof m === 'string' ? m : m.model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
}

export function isEmbeddingsEnabled( config: any ): boolean {
    return config.embeddings === true;
}

export function isSttOrTtsOnlyConfig( config: any ): boolean {
    return config.stt === true || config.tts === true;
}

export function providerSupportsModalities( config: any, requiredModalities: readonly string[] ): boolean {
    const providerModalities = new Set( config.modalities?.input ?? ['text', 'image', 'audio', 'file'] );
    return requiredModalities.every( ( modality ) => providerModalities.has( modality ) )
        || config.models.some( ( model: any ) => modelEntrySupportsModalities( config, model, requiredModalities ) );
}

export function modelSupportsModalities( config: any, modelName: string, requiredModalities: readonly string[], providerSupportsModalities: ( config: any, m: readonly string[] ) => boolean, modelEntrySupportsModalities: ( config: any, model: any, m: readonly string[] ) => boolean ): boolean {
    const modelEntry = config.models.find( ( model: any ) => {
        const candidate = typeof model === 'string' ? model : model.model;
        return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
    } );
    return modelEntry ? modelEntrySupportsModalities( config, modelEntry, requiredModalities ) : providerSupportsModalities( config, requiredModalities );
}

export function modelEntrySupportsModalities( config: any, model: any, requiredModalities: readonly string[] ): boolean {
    const modalities = new Set( typeof model === 'object'
        ? ( model.modalities?.input ?? config.modalities?.input ?? ['text', 'image', 'audio', 'file'] )
        : ( config.modalities?.input ?? ['text', 'image', 'audio', 'file'] ) );
    return requiredModalities.every( ( modality ) => modalities.has( modality ) );
}

export function buildRouteCacheKey( modelName: string, requiredModalities: readonly string[] ): string {
    return `${stripFreeModifier( modelName ).normalizedId}|${[...requiredModalities].sort().join( ',' )}`;
}

export function hasExplicitReasoningRequest( body: any ): boolean {
    return typeof body?.reasoning_effort === 'string'
        || typeof body?.reasoning?.effort === 'string'
        || typeof body?.thinking?.effort === 'string'
        || body?.include_reasoning === true
        || body?.output_reasoning === true;
}

export function isReasoningConfiguredForModel( config: any, selectedModel: string ): boolean {
    const hasProviderReasoning = Object.prototype.hasOwnProperty.call( config, 'reasoning_efforts' )
        || Object.prototype.hasOwnProperty.call( config, 'default_reasoning' );
    if ( hasProviderReasoning ) return true;
    const modelEntry = config.models.find( ( model: any ) => {
        const modelName = typeof model === 'string' ? model : model.model;
        return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );
    return !!modelEntry
        && typeof modelEntry === 'object'
        && ( Object.prototype.hasOwnProperty.call( modelEntry, 'reasoning_efforts' )
            || Object.prototype.hasOwnProperty.call( modelEntry, 'default_reasoning' ) );
}

export function resolveReasoningEffort( body: any, config: any, selectedModel: string ): string | undefined {
    if ( !isReasoningConfiguredForModel( config, selectedModel ) ) return undefined;
    if ( typeof body?.reasoning_effort === 'string' ) return body.reasoning_effort;
    if ( typeof body?.reasoning?.effort === 'string' ) return body.reasoning.effort;
    if ( typeof body?.thinking?.effort === 'string' ) return body.thinking.effort;
    const modelEntry = config.models.find( ( model: any ) => {
        const modelName = typeof model === 'string' ? model : model.model;
        return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );
    if ( modelEntry && typeof modelEntry === 'object' && modelEntry.default_reasoning ) return modelEntry.default_reasoning;
    return config.default_reasoning;
}

export function stripReasoningFields( body: any ): any {
    if ( !body || typeof body !== 'object' ) return body;
    const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
    return rest;
}

export function countTokensFromContent( content: any ): number {
    if ( typeof content === 'string' ) return Math.max( 1, Math.ceil( content.length / 4 ) );
    if ( Array.isArray( content ) ) {
        return content.reduce( ( sum: number, block: any ) => {
            if ( block.type === 'text' && block.text ) return sum + Math.max( 1, Math.ceil( block.text.length / 4 ) );
            return sum;
        }, 0 );
    }
    return 0;
}

export function buildWebSearchEncryptedContent( title: string, url: string, snippet: string ): string {
    return Buffer.from( JSON.stringify( { title, url, snippet } ) ).toString( 'base64' );
}

export function buildCodeInterpreterSessionId(): string {
    return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
}

export function ensureToolCallThoughtSignatures( body: any ): any {
    if ( !body || typeof body !== 'object' ) return body;
    if ( !Array.isArray( body.messages ) ) return body;
    const FALLBACK_SIG = 'skip_thought_signature_validator';
    let changed = false;
    const messages = body.messages.map( ( message: any ) => {
        if ( !message || !Array.isArray( message.tool_calls ) ) return message;
        const toolCalls = message.tool_calls.map( ( toolCall: any ) => {
            if ( !toolCall || typeof toolCall !== 'object' ) return toolCall;
            const existingSig = toolCall.extra_content?.google?.thought_signature || toolCall.thought_signature || toolCall.function?.thought_signature;
            if ( existingSig ) {
                if ( toolCall.extra_content?.google?.thought_signature && toolCall.function?.thought_signature ) return toolCall;
                changed = true;
                return { ...toolCall, thought_signature: existingSig, function: { ...( toolCall.function || {} ), thought_signature: existingSig }, extra_content: { ...( toolCall.extra_content || {} ), google: { ...( toolCall.extra_content?.google || {} ), thought_signature: existingSig } } };
            }
            changed = true;
            return { ...toolCall, thought_signature: FALLBACK_SIG, function: { ...( toolCall.function || {} ), thought_signature: FALLBACK_SIG }, extra_content: { ...( toolCall.extra_content || {} ), google: { ...( toolCall.extra_content?.google || {} ), thought_signature: FALLBACK_SIG } } };
        } );
        if ( toolCalls === message.tool_calls ) return message;
        return { ...message, tool_calls: toolCalls };
    } );
    return changed ? { ...body, messages } : body;
}

export function buildAnthropicWebSearchBlocks( searchResponse: any, buildEncrypted: ( t: string, u: string, s: string ) => string ): any[] {
    const toolUseId = `srvtoolu_${Date.now().toString( 36 )}`;
    const toolResultContent = searchResponse.citations.map( ( citation: any ) => ({ type: 'web_search_result', url: citation.url, title: citation.title, encrypted_content: buildEncrypted( citation.title, citation.url, citation.snippet ) }) );
    return [
        { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: { query: searchResponse.query } },
        { type: 'web_search_tool_result', tool_use_id: toolUseId, content: toolResultContent },
    ];
}

export function getRequiredModalities( body: any ): string[] {
    const modalities = new Set<string>( ['text'] );
    for ( const message of Array.isArray( body?.messages ) ? body.messages : [] ) {
        const content = message?.content;
        if ( !Array.isArray( content ) ) continue;
        for ( const block of content ) {
            if ( block?.type === 'image' || block?.type === 'image_url' ) modalities.add( 'image' );
            else if ( block?.type === 'audio' || block?.type === 'input_audio' ) modalities.add( 'audio' );
            else if ( block?.type === 'file' || block?.type === 'input_file' ) modalities.add( 'file' );
        }
    }
    return Array.from( modalities );
}
