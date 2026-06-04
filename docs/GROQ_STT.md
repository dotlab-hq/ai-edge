# Groq Speech-to-Text (Whisper)

## Overview

Groq API provides fast speech-to-text via Whisper models with OpenAI-compatible endpoints.

## API Endpoints

| Endpoint       | Usage                           | API Endpoint                                        |
| -------------- | ------------------------------- | --------------------------------------------------- |
| Transcriptions | Convert audio to text           | https://api.groq.com/openai/v1/audio/transcriptions |
| Translations   | Translate audio to English text | https://api.groq.com/openai/v1/audio/translations   |

## Supported Models

| Model ID               | Supported Language(s) | Transcription | Translation | Real-time Speed Factor | Word Error Rate | Cost Per Hour |
| ---------------------- | --------------------- | ------------- | ----------- | ---------------------- | --------------- | ------------- |
| whisper-large-v3-turbo | Multilingual          | Yes           | No          | 216                    | 12%             | $0.04         |
| whisper-large-v3       | Multilingual          | Yes           | Yes         | 189                    | 10.3%           | $0.111        |

### Which Model to Use?

- **whisper-large-v3**: Error-sensitive, multilingual, highest accuracy
- **whisper-large-v3-turbo**: Best price/performance, multilingual

## Audio File Limits

| Constraint                        | Value                                           |
| --------------------------------- | ----------------------------------------------- |
| Max File Size (free tier)         | 25 MB                                           |
| Max File Size (dev tier)          | 100 MB                                          |
| Minimum File Length               | 0.01 seconds                                    |
| Minimum Billed Length             | 10 seconds                                      |
| Supported File Types              | flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm |
| Supported Response Formats        | json, verbose_json, text                        |
| Supported Timestamp Granularities | segment, word                                   |

## Request Parameters

| Parameter                 | Type   | Default                | Description                                          |
| ------------------------- | ------ | ---------------------- | ---------------------------------------------------- |
| file                      | string | Required (unless url)  | Audio file object for upload                         |
| url                       | string | Required (unless file) | Audio URL (supports Base64URL)                       |
| language                  | string | Optional               | Language in ISO-639-1 format (e.g., `en`, `tr`)      |
| model                     | string | Required               | Model ID to use                                      |
| prompt                    | string | Optional               | Style/spelling guidance (max 224 tokens)             |
| response_format           | string | json                   | Output format: `json`, `verbose_json`, `text`        |
| temperature               | float  | 0                      | Temperature between 0 and 1                          |
| timestamp_granularities[] | array  | segment                | `word`, `segment`, or both (requires `verbose_json`) |

## Audio Preprocessing

Downsample to 16KHz mono for optimal speech recognition:

```bash
ffmpeg \
  -i <input_file> \
  -ar 16000 \
  -ac 1 \
  -map 0:a \
  -c:a flac \
  <output_file>.flac
```

## Verbose JSON Metadata Fields

| Field               | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `avg_logprob`       | Average log probability (closer to 0 = better confidence)       |
| `no_speech_prob`    | No speech probability (closer to 1 = likely silence/non-speech) |
| `compression_ratio` | Healthy values ~1.6; unusual values indicate speech issues      |

## Quick Start (curl)

```bash
curl https://api.groq.com/openai/v1/audio/transcriptions \
  -X POST \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -F file=@audio.wav \
  -F model=whisper-large-v3-turbo \
  -F language=en
```

## Prompting Guidelines

- Provide relevant context about audio content
- Use the same language as the audio file
- Denote proper spellings or emulate a writing style
- Keep prompt concise and focused on stylistic guidance
