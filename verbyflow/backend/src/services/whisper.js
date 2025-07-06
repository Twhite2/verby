const axios = require('axios');
const fs = require('fs-extra');
const FormData = require('form-data');
const path = require('path');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger('whisper-service');

/**
 * Transcribe audio using OpenAI's Whisper API
 * 
 * @param {string} audioFilePath - Path to the audio file
 * @param {object} options - Additional options for the Whisper API
 * @returns {Promise<object>} - Transcription result
 */
async function transcribeAudio(audioFilePath, options = {}) {
  try {
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }
    
    // Get file size to log and validate
    const stats = fs.statSync(audioFilePath);
    logger.debug(`Transcribing audio file: ${path.basename(audioFilePath)} (${stats.size} bytes)`);
    
    // Check if file size is too small (likely to fail transcription)
    if (stats.size < 1000) {
      logger.warn(`Audio file too small: ${stats.size} bytes, skipping transcription`);
      return { text: '', error: 'Audio file too small for transcription' };
    }
    
    // Prepare form data for API request
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFilePath));
    formData.append('model', options.model || 'whisper-1');
    
    // Optional parameters
    if (options.language) {
      formData.append('language', options.language);
    }
    
    if (options.prompt) {
      formData.append('prompt', options.prompt);
    }
    
    if (options.response_format) {
      formData.append('response_format', options.response_format);
    }
    
    if (options.temperature) {
      formData.append('temperature', options.temperature);
    }
    
    // Make request to OpenAI API
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      timeout: 30000, // 30 seconds timeout
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    logger.debug(`Transcription completed successfully: "${response.data.text.substring(0, 50)}..."`);
    return response.data;
  } catch (error) {
    if (error.response) {
      // API responded with an error
      logger.error('Whisper API error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
      throw new Error(`Whisper API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      // Request was made but no response received
      logger.error('No response from Whisper API:', error.message);
      throw new Error(`No response from Whisper API: ${error.message}`);
    } else {
      // Error setting up request
      logger.error('Error setting up transcription request:', error.message);
      throw new Error(`Error setting up transcription request: ${error.message}`);
    }
  }
}

module.exports = {
  transcribeAudio
};
