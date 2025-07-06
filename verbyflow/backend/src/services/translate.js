const translate = require('@vitalets/google-translate-api');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger('translate-service');

/**
 * Translate text from one language to another using @vitalets/google-translate-api
 * This uses the free Google Translate web service without requiring API keys
 * 
 * @param {string} text - Text to translate
 * @param {string} sourceLang - Source language code (or 'auto' for auto-detection)
 * @param {string} targetLang - Target language code
 * @returns {Promise<string>} - Translated text
 */
async function translateText(text, sourceLang = 'auto', targetLang = 'en') {
  try {
    // Skip translation if text is empty
    if (!text || text.trim() === '') {
      return '';
    }
    
    logger.debug(`Translating text from ${sourceLang} to ${targetLang}: "${text.substring(0, 50)}..."`);
    
    const result = await translate(text, { 
      from: sourceLang, 
      to: targetLang 
    });
    
    if (result && result.text) {
      const translatedText = result.text;
      logger.debug(`Translation successful: "${translatedText.substring(0, 50)}..."`);
      return translatedText;
    }
    
    logger.warn('Translation response did not contain expected text');
    return text;
  } catch (error) {
    logger.error('Error translating text:', error.message);
    
    // Fallback to original text on error
    return text;
  }
}

module.exports = {
  translateText
};
