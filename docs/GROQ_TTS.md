# Groq Text-to-Speech (Orpheus)

## Overview

Groq API provides fast text-to-speech via Orpheus models by Canopy Labs.

## API Endpoint

| Endpoint | Usage                 | API Endpoint                                |
| -------- | --------------------- | ------------------------------------------- |
| Speech   | Convert text to audio | https://api.groq.com/openai/v1/audio/speech |

## Supported Models

| Model ID                        | Language       | Description                                  |
| ------------------------------- | -------------- | -------------------------------------------- |
| canopylabs/orpheus-v1-english   | English        | Expressive TTS with vocal direction controls |
| canopylabs/orpheus-arabic-saudi | Arabic (Saudi) | Authentic Saudi dialect synthesis            |

## Pricing

| Model ID                        | Price               |
| ------------------------------- | ------------------- |
| canopylabs/orpheus-v1-english   | $22 / 1M characters |
| canopylabs/orpheus-arabic-saudi | $40 / 1M characters |

## Request Parameters

| Parameter       | Type   | Required | Description                                                                          |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| model           | string | Yes      | `canopylabs/orpheus-v1-english` or `canopylabs/orpheus-arabic-saudi`                 |
| input           | string | Yes      | Text to convert to speech (max 200 characters). Use `[directions]` for vocal control |
| voice           | string | Yes      | Voice persona ID (see Available Voices)                                              |
| response_format | string | Optional | Audio format. Defaults to `"wav"`. **Only supported format is `"wav"`**              |

## Available Voices

### English Voices

| Name   | ID     | Gender |
| ------ | ------ | ------ |
| Autumn | autumn | Female |
| Diana  | diana  | Female |
| Hannah | hannah | Female |
| Austin | austin | Male   |
| Daniel | daniel | Male   |
| Troy   | troy   | Male   |

### Arabic Saudi Dialect Voices

| Name     | ID       | Gender |
| -------- | -------- | ------ |
| Abdullah | abdullah | Male   |
| Fahad    | fahad    | Male   |
| Sultan   | sultan   | Male   |
| Lulwa    | lulwa    | Female |
| Noura    | noura    | Female |
| Aisha    | aisha    | Female |

## Vocal Directions (English Model)

Use bracketed text like `[cheerful]` or `[whisper]` to control expression.

### Common Directions

- **Conversational:** `[cheerful]`, `[friendly]`, `[casual]`, `[warm]`
- **Professional:** `[professionally]`, `[authoritatively]`, `[formally]`, `[confidently]`
- **Expressive:** `[whisper]`, `[excited]`, `[dramatic]`, `[deadpan]`, `[sarcastic]`
- **Vocal qualities:** `[gravelly whisper]`, `[rapid babbling]`, `[singsong]`, `[breathy]`

### Tips

- More directions = more expressive, acted performance
- Fewer/no directions = natural, casual conversational cadence
- Use 1-2 word directions (typically adjectives or adverbs)

## Limitations

- Input text length is limited to **200 characters**
- Batch processing API is not supported
- Only `wav` response format is supported

## Quick Start (curl)

```bash
curl https://api.groq.com/openai/v1/audio/speech \
  -X POST \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "canopylabs/orpheus-v1-english",
    "input": "[cheerful] Welcome to Orpheus text-to-speech!",
    "voice": "troy",
    "response_format": "wav"
  }' \
  --output orpheus-english.wav
```
