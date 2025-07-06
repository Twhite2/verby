const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const { setupLogger } = require('./logger');

const logger = setupLogger('audio-utils');

/**
 * Detect the audio format of a given file by examining its header and contents
 * This is a simplified version that detects common formats sent from browsers
 * 
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<string>} - Detected format ('webm', 'ogg', 'wav', etc.)
 */
async function detectAudioFormat(filePath) {
  try {
    // Read the first 16 bytes of the file
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(16);
    await fs.read(fd, buffer, 0, 16, 0);
    await fs.close(fd);

    // Check for WAV format (RIFF header)
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
      logger.debug('Detected WAV format');
      return 'wav';
    }
    
    // Check for OGG format (OggS header)
    if (buffer.toString('ascii', 0, 4) === 'OggS') {
      logger.debug('Detected OGG format');
      return 'ogg';
    }
    
    // Check for WebM format (EBML header)
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
      logger.debug('Detected WebM format');
      return 'webm';
    }
    
    // Check for MP3 format (ID3 or frame sync)
    if (
      (buffer.toString('ascii', 0, 3) === 'ID3') || 
      (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)
    ) {
      logger.debug('Detected MP3 format');
      return 'mp3';
    }

    // Try to detect format using ffprobe
    try {
      const { stdout } = await execAsync(`ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
      const format = stdout.trim().split(',')[0]; // Get first format if multiple are returned
      
      if (format) {
        logger.debug(`Detected format using ffprobe: ${format}`);
        return format;
      }
    } catch (ffprobeError) {
      logger.warn(`Failed to detect format using ffprobe: ${ffprobeError.message}`);
    }
    
    // Check file extension as last resort
    const extension = path.extname(filePath).toLowerCase().slice(1);
    if (extension) {
      logger.debug(`Using file extension to determine format: ${extension}`);
      return extension;
    }

    // Unknown format
    logger.warn('Could not detect audio format, defaulting to webm');
    return 'webm'; // Default to WebM as fallback
  } catch (error) {
    logger.error('Error detecting audio format:', error);
    return 'unknown';
  }
}

/**
 * Convert audio format to WAV (if needed) for better compatibility with Whisper API
 * 
 * @param {string} inputFilePath - Path to the input audio file
 * @param {string} detectedFormat - The detected format of the input file
 * @returns {Promise<string>} - Path to the processed audio file
 */
async function convertAudioFormatIfNeeded(inputFilePath, detectedFormat) {
  // If already in WAV format, no conversion needed
  if (detectedFormat === 'wav') {
    logger.debug('Audio already in WAV format, no conversion needed');
    return inputFilePath;
  }
  
  // Define output file path
  const outputFilePath = `${inputFilePath.slice(0, -path.extname(inputFilePath).length)}.wav`;
  
  try {
    logger.debug(`Converting ${detectedFormat} to WAV format`);
    
    // Execute ffmpeg to convert the audio
    await execAsync(`ffmpeg -i "${inputFilePath}" -y -ar 16000 -ac 1 -c:a pcm_s16le "${outputFilePath}"`);
    
    logger.debug(`Successfully converted audio to WAV format: ${outputFilePath}`);
    return outputFilePath;
  } catch (error) {
    logger.error(`Error converting audio format: ${error.message}`);
    
    // If conversion fails, try a different approach for WebM or OGG formats
    if (['webm', 'ogg'].includes(detectedFormat)) {
      try {
        logger.debug('Attempting alternative conversion approach for WebM/OGG');
        await execAsync(`ffmpeg -i "${inputFilePath}" -y -ar 16000 -ac 1 -f wav "${outputFilePath}"`);
        return outputFilePath;
      } catch (altError) {
        logger.error(`Alternative conversion failed: ${altError.message}`);
      }
    }
    
    // If all conversion attempts fail, return the original file
    logger.warn('Audio conversion failed, returning original file');
    return inputFilePath;
  }
}

module.exports = {
  detectAudioFormat,
  convertAudioFormatIfNeeded
};
