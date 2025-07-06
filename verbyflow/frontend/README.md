# VerbyFlow Frontend

## Overview
This is the Vue.js frontend for VerbyFlow, a real-time multilingual voice communication platform. The frontend captures audio from the user's microphone, sends it to the backend for processing via WebSockets, and plays back received audio while displaying transcriptions and translations.

## Key Features
- Real-time audio recording and streaming
- WebSocket communication with backend
- Audio visualization for input and output levels
- Voice activity detection
- Real-time transcription display
- Support for multiple languages
- Modern UI with responsive design

## Project Structure
```
frontend/
├── public/              # Static assets
├── src/                 # Source code
│   ├── assets/          # Images and other assets
│   ├── components/      # Vue components
│   ├── router/          # Vue Router configuration
│   ├── services/        # Service modules (WebSocket, etc.)
│   ├── store/           # Vuex store modules
│   │   ├── modules/     # Store modules (audio, call, user)
│   │   └── index.js     # Store entry point
│   ├── views/           # Page components
│   ├── App.vue          # Root component
│   └── main.js          # Entry point
├── .env.example         # Environment variables example
├── babel.config.js      # Babel configuration
├── package.json         # Dependencies and scripts
└── vue.config.js        # Vue CLI configuration
```

## Technical Stack
- Vue.js 3
- Vuex 4 (State Management)
- Vue Router 4
- WebAudio API for audio processing and visualization
- MediaRecorder API for audio capture
- WebSockets for real-time communication with backend

## Getting Started

### Prerequisites
- Node.js 14+
- npm or yarn

### Installation
1. Install dependencies:
```
npm install
```

2. Create a `.env` file based on the `.env.example` template.

### Development
Start the development server:
```
npm run serve
```

### Production Build
Build for production:
```
npm run build
```

## Integration with Backend
The frontend communicates with the backend through two main channels:
1. **REST API** - Used for call creation, joining, and user management
2. **WebSockets** - Used for real-time audio streaming, transcriptions, and translations

### Audio Processing Flow
1. User starts recording audio via the UI
2. Audio is captured in chunks using the MediaRecorder API
3. Audio chunks are sent to the backend via WebSocket
4. Backend processes the audio (Whisper API, translation, TTS)
5. Processed audio is sent back to all clients in the call
6. Received audio is played back using the Audio API

### WebSocket Message Types
- `audio_chunk`: Individual audio chunks during recording
- `audio_data`: Complete utterances detected by silence detection
- `transcription`: Text transcriptions from Whisper API
- `translation`: Translated text in the target language

## Customization
- Change the WebSocket server URL in the `.env` file
- Modify audio capture settings in the audio store module
- Add or remove languages in the user store module
