import type { Context } from 'hono';
import type { BackendState, OpenAIModelConfig } from '../types';
import { normalizeToolSearchForEndpoint } from '../proxyRequest';
import { prepareFileSearchForResponses } from '../fileSearch';
import { runProxyRequest } from '../providerLoop';
import { isSkillResolverReady, resolveOpenAIBody } from '../../SkillResolver';
import { convertResponsesRequestToChat } from '../../ResponsesConversion';
import { shouldUseOpenAICodeInterpreter, proxyCodeInterpreterRequest } from './codeInterpreter';

export async function handleChatCompletions( c: Context, state: BackendState ) {
    return handleOpenAIRequest( c, state, 'chat/completions' );
}

export async function handleCompletions( c: Context, state: BackendState ) {
    return runProxyRequest( { c, state, endpoint: 'completions' } ).then( r => r.response );
}

export async function handleOpenAIRequest( c: Context, state: BackendState, endpoint: string ) {
    const rawBody = await c.req.json().catch( () => ( {} ) );

    if ( isSkillResolverReady() ) {
        await resolveOpenAIBody( rawBody );
    }

    const normalizedBody = normalizeToolSearchForEndpoint( rawBody, endpoint );

    if ( shouldUseOpenAICodeInterpreter( normalizedBody ) ) {
        return proxyCodeInterpreterRequest( c, state, endpoint, normalizedBody );
    }

    if ( endpoint === 'responses' ) {
        const fileSearchContext = await prepareFileSearchForResponses( normalizedBody );
        const converted = convertResponsesRequestToChat( fileSearchContext.body );
        return runProxyRequest( { c, state, endpoint: 'chat/completions', rawBody: converted, originalResponsesBody: normalizedBody, fileSearchCalls: fileSearchContext.searchCalls } )
            .then( r => r.response );
    }

    return runProxyRequest( { c, state, endpoint, rawBody: normalizedBody } ).then( r => r.response );
}
