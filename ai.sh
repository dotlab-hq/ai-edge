#!/bin/bash

# Test Anthropic streaming support through local proxy

API_URL="http://localhost:8888/anthropic/v1/messages"
API_KEY="${ANTHROPIC_API_KEY:-}"

if [ -z "$API_KEY" ]; then
    echo "Error: ANTHROPIC_API_KEY environment variable not set"
    exit 1
fi

curl -N "$API_URL" \
  --header "x-api-key: $API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-opus-4-7",  
    "messages": [
      {
        "role": "user",
        "content": "tell me about recent gwaliior kidnapping ase where a boy kidnapped a girl  initliy  it was love story later it was osmething else"
      }
    ],
    "tools": [
      {
        "type": "web_search_k",
        "name": "web_search",
        "max_uses": 5
      }
    ]
  }'