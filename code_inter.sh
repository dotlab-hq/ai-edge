curl http://localhost:8888/openai/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer qwerty-asdf" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "What is the age of the universe?"
      }
    ]
  }'