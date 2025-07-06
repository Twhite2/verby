# VerbyFlow Backend

A real-time audio transcription, translation, and text-to-speech backend server for the VerbyFlow application.

## Features

- Real-time audio streaming via WebSockets (Socket.IO)
- Audio format detection and conversion using FFmpeg
- Speech-to-text using OpenAI's Whisper API
- Optional text translation using Google Translate API
- Optional text-to-speech using Google TTS or ElevenLabs
- Detailed logging for debugging and monitoring

## Prerequisites

- Node.js v14.x or higher
- npm v6.x or higher
- FFmpeg installed and available in the system PATH
- OpenAI API key
- Optional: Google API key (for translation and TTS)
- Optional: ElevenLabs API key (for high-quality TTS)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/verbyflow.git
   cd verbyflow/backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. Edit the `.env` file with your API keys and configuration.

## Usage

### Starting the Development Server

```bash
npm run dev
```

The server will be available at http://localhost:3000 (or the port specified in your .env file).

### Starting the Production Server

```bash
npm start
```

## API Endpoints

- `GET /` - Basic server info
- `GET /health` - Health check endpoint

## WebSocket Events

### Client to Server

- `join` - Join a call with callId and userId
- `audio_chunk` - Send a chunk of audio data for processing
- `audio_data` - Send a complete audio utterance for processing

### Server to Client

- `transcription` - Transcribed text from audio
- `translation` - Translated text (if enabled)
- `audio` - Synthesized speech audio (if TTS is enabled)
- `error` - Error message

## Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment mode (development, production)
- `OPENAI_API_KEY` - OpenAI API key (required)
- `GOOGLE_API_KEY` - Google API key (optional, for translation and TTS)
- `ELEVENLABS_API_KEY` - ElevenLabs API key (optional, for high-quality TTS)
- `ENABLE_TRANSLATION` - Enable/disable translation (true/false)
- `ENABLE_TTS` - Enable/disable text-to-speech (true/false)

## Directory Structure

```
backend/
├── config/         # Configuration files
├── logs/           # Log files
├── src/
│   ├── services/   # API service modules
│   │   ├── whisper.js   # OpenAI Whisper service
│   │   ├── translate.js # Translation service
│   │   └── tts.js       # Text-to-speech service
│   ├── utils/      # Utility functions
│   │   ├── audio.js     # Audio processing utilities
│   │   └── logger.js    # Logging utilities
│   └── server.js   # Main server entry point
├── temp/           # Temporary files (audio chunks, etc.)
├── .env            # Environment variables (create from .env.example)
├── .env.example    # Example environment variables
└── package.json    # Project dependencies and scripts
```

## License

MIT
