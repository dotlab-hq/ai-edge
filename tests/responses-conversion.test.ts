import { expect, test } from 'bun:test';
import {
    createResponsesStreamState,
    emitResponsesCompleted,
    emitResponsesStreamPreamble,
    processChatStreamChunkForResponses,
} from '../src/core/ResponsesConversion';

test( 'Responses stream preamble is emitted immediately and only once', () => {
    const state = createResponsesStreamState( { model: 'gpt-5.4' } as any, 1234 );
    const out: string[] = [];

    emitResponsesStreamPreamble( state, out );
    emitResponsesStreamPreamble( state, out );

    expect( state.hasEmittedResponse ).toBe( true );
    expect( out.join( '' ).match( /event: response\.created/g ) ).toHaveLength( 1 );
    expect( out.join( '' ) ).toContain( 'event: response.in_progress' );
} );

test( 'Responses stream finish closes items without re-emitting preamble', () => {
    const state = createResponsesStreamState( { model: 'gpt-5.4' } as any, 1234 );
    const out: string[] = [];

    emitResponsesStreamPreamble( state, out );
    out.length = 0;

    const finished = processChatStreamChunkForResponses(
        {
            choices: [
                {
                    index: 0,
                    delta: { content: 'hello' },
                    finish_reason: 'stop',
                },
            ],
        } as any,
        state,
        out,
    );

    expect( finished ).toBe( true );
    expect( out.join( '' ) ).toContain( 'event: response.output_item.done' );
    expect( out.join( '' ) ).not.toContain( 'event: response.created' );
} );

test( 'Responses completed event carries the final response envelope', () => {
    const state = createResponsesStreamState( { model: 'gpt-5.4' } as any, 1234 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        {
            choices: [
                {
                    index: 0,
                    delta: { content: 'hello' },
                    finish_reason: 'stop',
                },
            ],
        } as any,
        state,
        out,
    );

    out.length = 0;
    emitResponsesCompleted( state, out );

    expect( out.join( '' ) ).toContain( 'event: response.completed' );
    expect( out.join( '' ) ).toContain( '"type":"response.completed"' );
    expect( out.join( '' ) ).toContain( '"response":' );
    expect( out.join( '' ) ).toContain( 'hello' );
} );
