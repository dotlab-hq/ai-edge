curl -sS http://localhost:8888/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4.1",
    "tools": [
      {
        "type": "code_interpreter",
        "container": {
          "type": "auto"
        }
      }
    ],
    "input": [
      {
        "role": "system",
        "content": "You are a helpful AI assistant."
      },
      {
        "role": "user",
        "content": "Solve the equation 3x + 11 = 14"
      }
    ]
  }' | bun -e '
const input = await new Response( Bun.stdin ).text();

try {
  const payload = JSON.parse( input );
  const message = payload?.output?.find( ( item ) => item?.type === "message" );
  const outputText = message?.content?.find( ( block ) => block?.type === "output_text" )?.text;

  if ( typeof outputText === "string" && outputText.length > 0 ) {
    process.stdout.write( outputText.trim() + "\n" );
  } else {
    process.stdout.write( "No assistant text found.\n" );
  }
} catch ( error ) {
  process.stdout.write( input );
  if ( !input.endsWith( "\n" ) ) {
    process.stdout.write( "\n" );
  }
}
'