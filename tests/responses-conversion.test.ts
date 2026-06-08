import { expect, test } from 'bun:test';
import {
    createResponsesStreamState,
    emitResponsesCompleted,
    emitResponsesStreamPreamble,
    processChatStreamChunkForResponses,
    buildStreamOutputItems,
    sseEventsToWsFrames,
} from '../src/core/ResponsesConversion';

function parseEvents( out: string[] ): Array<{ type: string; data: any }> {
    const events: Array<{ type: string; data: any }> = [];
    const joined = out.join( '' );
    const blocks = joined.split( '\n\n' ).filter( Boolean );
    for ( const block of blocks ) {
        const typeMatch = block.match( /event: (.+)/ );
        const dataMatch = block.match( /data: (.+)/s );
        if ( typeMatch && dataMatch ) {
            events.push( { type: typeMatch[1].trim(), data: JSON.parse( dataMatch[1].trim() ) } );
        }
    }
    return events;
}

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

// ── Reasoning content tests ────────────────────────────────────

test( 'reasoning_content from upstream produces reasoning output item', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );

    const events = parseEvents( out );
    const types = events.map( e => e.type );

    expect( types ).toContain( 'response.output_item.added' );
    expect( types ).toContain( 'response.content_part.added' );
    expect( types ).toContain( 'response.reasoning_summary_text.delta' );

    const added = events.find( e => e.type === 'response.output_item.added' );
    expect( added!.data.item.type ).toBe( 'reasoning' );

    const delta = events.find( e => e.type === 'response.reasoning_summary_text.delta' );
    expect( delta!.data.delta ).toBe( 'thinking...' );

    // Reasoning item should be accumulated
    expect( state.reasoningItems ).toHaveLength( 1 );
    expect( state.reasoningItems[0].text ).toBe( 'thinking...' );
} );

test( 'reasoning block is closed when text content starts (no output index collision)', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    // Chunk 1: reasoning
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );
    out.length = 0;

    // Chunk 2: text — should close reasoning first
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'answer' } }] } as any,
        state,
        out,
    );

    const events = parseEvents( out );

    // Reasoning block should be closed (done event) before text starts
    const reasoningDoneIdx = events.findIndex( e => e.type === 'response.output_item.done' && e.data.item?.type === 'reasoning' );
    const textAddedIdx = events.findIndex( e => e.type === 'response.output_item.added' && e.data.item?.type === 'message' );

    expect( reasoningDoneIdx ).toBeGreaterThanOrEqual( 0 );
    expect( textAddedIdx ).toBeGreaterThanOrEqual( 0 );
    expect( reasoningDoneIdx ).toBeLessThan( textAddedIdx );

    // output_index 0 = reasoning, output_index 1 = message
    expect( events[reasoningDoneIdx].data.output_index ).toBe( 0 );
    expect( events[textAddedIdx].data.output_index ).toBe( 1 );

    // Both text and reasoning accumulated
    expect( state.reasoningItems[0].text ).toBe( 'thinking...' );
    expect( state.textItems[0].text ).toBe( 'answer' );
} );

test( 'multiple reasoning chunks are accumulated', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'let me ' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'think...' } }] } as any,
        state,
        out,
    );

    expect( state.reasoningItems ).toHaveLength( 1 );
    expect( state.reasoningItems[0].text ).toBe( 'let me think...' );
} );

test( 'reasoning closes via null sentinel ([DONE])', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );
    out.length = 0;

    // [DONE] sentinel should close the reasoning block
    processChatStreamChunkForResponses( null, state, out );

    expect( state.currentReasoningBlockOpen ).toBe( false );

    const events = parseEvents( out );
    const reasoningDone = events.find( e => e.type === 'response.output_item.done' && e.data.item?.type === 'reasoning' );
    expect( reasoningDone ).toBeDefined();
} );

test( 'reasoning closes via finish_reason without content', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );
    out.length = 0;

    // finish_reason chunk with no content delta — should still close reasoning
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, finish_reason: 'stop' }] } as any,
        state,
        out,
    );

    expect( state.currentReasoningBlockOpen ).toBe( false );

    const events = parseEvents( out );
    const reasoningDone = events.find( e => e.type === 'response.output_item.done' && e.data.item?.type === 'reasoning' );
    expect( reasoningDone ).toBeDefined();
} );

test( 'emitResponsesCompleted includes reasoning items in output', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    // reasoning + text
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'answer' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, finish_reason: 'stop' }] } as any,
        state,
        out,
    );

    out.length = 0;
    emitResponsesCompleted( state, out );

    const events = parseEvents( out );
    const completed = events.find( e => e.type === 'response.completed' );
    const output = completed!.data.response.output;

    expect( output ).toHaveLength( 2 );
    expect( output[0].type ).toBe( 'reasoning' );
    expect( output[0].summary[0].text ).toBe( 'thinking...' );
    expect( output[1].type ).toBe( 'message' );
    expect( output[1].content[0].text ).toBe( 'answer' );
} );

test( 'buildStreamOutputItems includes reasoning items', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'answer' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses( null, state, out );

    const items = buildStreamOutputItems( state );
    expect( items ).toHaveLength( 2 );
    expect( items[0].type ).toBe( 'reasoning' );
    expect( items[1].type ).toBe( 'message' );
} );

test( 'text-only stream without reasoning works unchanged', () => {
    const state = createResponsesStreamState( { model: 'gpt-5.4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'hello ' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'world' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, finish_reason: 'stop' }] } as any,
        state,
        out,
    );

    expect( state.textItems ).toHaveLength( 1 );
    expect( state.textItems[0].text ).toBe( 'hello world' );
    expect( state.reasoningItems ).toHaveLength( 0 );

    const events = parseEvents( out );
    const messageAdded = events.filter( e => e.type === 'response.output_item.added' && e.data.item?.type === 'message' );
    const reasoningAdded = events.filter( e => e.type === 'response.output_item.added' && e.data.item?.type === 'reasoning' );
    expect( messageAdded ).toHaveLength( 1 );
    expect( reasoningAdded ).toHaveLength( 0 );
} );

test( 'reasoning via delta.reasoning alias works', () => {
    const state = createResponsesStreamState( { model: 'some-model' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning: 'thoughts...' } }] } as any,
        state,
        out,
    );

    expect( state.reasoningItems ).toHaveLength( 1 );
    expect( state.reasoningItems[0].text ).toBe( 'thoughts...' );
} );

test( 'reasoning via delta.thinking alias works', () => {
    const state = createResponsesStreamState( { model: 'some-model' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { thinking: 'deep thoughts...' } }] } as any,
        state,
        out,
    );

    expect( state.reasoningItems ).toHaveLength( 1 );
    expect( state.reasoningItems[0].text ).toBe( 'deep thoughts...' );
} );

test( 'full stream: reasoning -> text -> tool_call -> finish', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    // reasoning phase
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'analyzing...' } }] } as any,
        state,
        out,
    );
    // text phase
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'result' } }] } as any,
        state,
        out,
    );
    // tool_call phase
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }] } }] } as any,
        state,
        out,
    );
    // finish
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, finish_reason: 'tool_calls' }] } as any,
        state,
        out,
    );

    const items = buildStreamOutputItems( state );
    // reasoning, message, function_call
    expect( items ).toHaveLength( 3 );
    expect( items[0].type ).toBe( 'reasoning' );
    expect( items[1].type ).toBe( 'message' );
    expect( items[2].type ).toBe( 'function_call' );
    expect( items[2].name ).toBe( 'search' );
} );

test( 'output indices are sequential and non-colliding across reasoning + text', () => {
    const state = createResponsesStreamState( { model: 'deepseek-v4' } as any, 1 );
    const out: string[] = [];

    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, delta: { content: 'answer' } }] } as any,
        state,
        out,
    );
    processChatStreamChunkForResponses(
        { choices: [{ index: 0, finish_reason: 'stop' }] } as any,
        state,
        out,
    );

    const events = parseEvents( out );
    const outputIndices = events
        .filter( e => e.type === 'response.output_item.added' )
        .map( e => e.data.output_index );

    expect( outputIndices ).toEqual( [0, 1] );
} );

test( 'sseEventsToWsFrames extracts JSON from SSE format', () => {
    const sseEvents = [
        'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    ];
    const frames = sseEventsToWsFrames( sseEvents );
    expect( frames ).toHaveLength( 2 );
    expect( JSON.parse( frames[0] ) ).toEqual( { type: 'response.created', response: {} } );
    expect( JSON.parse( frames[1] ).delta ).toBe( 'hi' );
} );
