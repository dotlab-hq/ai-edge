curl http://localhost:8888/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "stream": true,
    "model": "auto-vgedge",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "100word essay on the benefits of exercise."
      }
    ]
  }'
