const axios = require('axios');
const fs = require('fs-extra');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger('tts-service');

/**
 * Synthesize speech from text using a Text-to-Speech API
 * This implementation provides two options:
 * 1. Google Cloud TTS (if GOOGLE_API_KEY is provided)
 * 2. ElevenLabs TTS (if ELEVENLABS_API_KEY is provided)
 * 
 * @param {string} text - Text to convert to speech
 * @param {string} languageCode - Language code (e.g., 'en-US', 'es-ES', etc.)
 * @param {object} options - Additional options for TTS
 * @returns {Promise<Buffer>} - Audio buffer containing the synthesized speech
 */
async function synthesizeSpeech(text, languageCode = 'en-US', options = {}) {
  try {
    // Skip empty text
    if (!text || text.trim() === '') {
      logger.warn('Empty text provided for TTS, skipping');
      return Buffer.from([]);
    }
    
    logger.debug(`Synthesizing speech for text: "${text.substring(0, 50)}..."`);
    
    // Check which TTS service to use based on available API keys
    if (process.env.ELEVENLABS_API_KEY) {
      return synthesizeWithElevenLabs(text, languageCode, options);
    } else if (process.env.GOOGLE_API_KEY) {
      return synthesizeWithGoogleTTS(text, languageCode, options);
    } else {
      logger.warn('No TTS API key configured, cannot synthesize speech');
      throw new Error('No TTS API key configured');
    }
  } catch (error) {
    logger.error('Error in speech synthesis:', error);
    throw new Error(`Failed to synthesize speech: ${error.message}`);
  }
}

/**
 * Synthesize speech using Google Cloud Text-to-Speech API
 */
async function synthesizeWithGoogleTTS(text, languageCode, options = {}) {
  try {
    const voice = options.voice || 'en-US-Neural2-F'; // Default to a neural voice
    const audioEncoding = options.audioEncoding || 'MP3';
    
    const requestData = {
      input: { text },
      voice: {
        languageCode,
        name: voice,
        ssmlGender: options.gender || 'FEMALE'
      },
      audioConfig: {
        audioEncoding,
        pitch: options.pitch || 0,
        speakingRate: options.speakingRate || 1.0
      }
    };
    
    const response = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      requestData,
      {
        params: { key: process.env.GOOGLE_API_KEY },
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    // Google TTS returns base64-encoded audio content
    if (response.data && response.data.audioContent) {
      const audioBuffer = Buffer.from(response.data.audioContent, 'base64');
      logger.debug(`Successfully synthesized ${audioBuffer.length} bytes of audio`);
      return audioBuffer;
    } else {
      throw new Error('No audio content in Google TTS response');
    }
  } catch (error) {
    logger.error('Google TTS API error:', error);
    throw new Error(`Google TTS error: ${error.message}`);
  }
}

/**
 * Synthesize speech using ElevenLabs API
 */
async function synthesizeWithElevenLabs(text, languageCode, options = {}) {
  try {
    // Default voice ID (you can change this to any voice from ElevenLabs)
    const voiceId = options.voiceId || '21m00Tcm4TlvDq8ikWAM';
    
    const requestData = {
      text,
      model_id: options.model || 'eleven_monolingual_v1',
      voice_settings: {
        stability: options.stability || 0.5,
        similarity_boost: options.similarity || 0.75
      }
    };
    
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      data: requestData,
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    });
    
    const audioBuffer = Buffer.from(response.data);
    logger.debug(`Successfully synthesized ${audioBuffer.length} bytes of audio with ElevenLabs`);
    return audioBuffer;
  } catch (error) {
    logger.error('ElevenLabs API error:', error);
    throw new Error(`ElevenLabs error: ${error.message}`);
  }
}

module.exports = {
  synthesizeSpeech
};
