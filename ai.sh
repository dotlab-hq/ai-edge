curl https://ai.wpsadi.dev/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "stream": true,
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "curl https://api.groq.com/openai/v1/audio/speech -X POST -H \"Authorization: Bearer $GROQ_API_KEY\" -H \"Content-Type: application/json\" -d '\''{\"model\":\"canopylabs/orpheus-v1-english\",\"input\":\"Welcome to Orpheus text-to-speech. [cheerful] This is an example of high-quality English audio generation with vocal directions support.\",\"voice\":\"austin\",\"response_format\":\"wav\"}'\'' --output orpheus-english.wav"
      }
    ]
  }'