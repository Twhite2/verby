const axios = require('axios');
const fs = require('fs-extra');
const FormData = require('form-data');
const path = require('path');
const { setupLogger } = require('../utils/logger');

// For debugging only - will be removed in production
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const logger = setupLogger('whisper-service');

// Check if API key is loaded
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  logger.error('OPENAI_API_KEY is not set in environment variables');
} else {
  logger.info('OPENAI_API_KEY is properly set, length: ' + openaiApiKey.length);
}

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
    
    // Get the API key with fallback mechanism
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!openaiApiKey) {
      logger.error('OPENAI_API_KEY is missing, cannot proceed with transcription');
      throw new Error('OpenAI API key is not configured. Please add it to your .env file.');
    }
    
    logger.info(`Using API key starting with: ${openaiApiKey.substring(0, 10)}... (length: ${openaiApiKey.length})`);
    
    // Add retry logic for transient errors
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        const response = await axios({
          method: 'post',
          url: 'https://api.openai.com/v1/audio/transcriptions',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'multipart/form-data'
          },
          data: formData,
          timeout: 45000, // 45 seconds timeout (increased from 30)
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
        
        logger.debug(`Transcription completed successfully: "${response.data.text?.substring(0, 50) || ''}..."`);
        return response.data;
      } catch (retryError) {
        // Check if this is a network error (like socket hang up) that we should retry
        if ((retryError.code === 'ECONNRESET' || 
             retryError.code === 'ETIMEDOUT' ||
             retryError.message.includes('socket hang up')) && 
            retryCount < maxRetries) {
          
          retryCount++;
          logger.warn(`Transcription network error (${retryError.message}), retrying attempt ${retryCount} of ${maxRetries}`);
          
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
          continue;
        }
        
        // If we get here, either we've exhausted our retries or it's a different kind of error
        // Re-throw to be handled by the outer catch
        throw retryError;
      }
    }
    
    // This should never be reached due to the throw above, but just in case
    throw new Error('Failed to transcribe after maximum retry attempts');
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
