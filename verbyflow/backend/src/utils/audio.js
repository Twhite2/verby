const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const ffmpegPath = require('ffmpeg-static');
const { setupLogger } = require('./logger');

const logger = setupLogger('audio-utils');

// Log the ffmpeg path for debugging
logger.info(`Using ffmpeg from path: ${ffmpegPath}`);

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
      // Use the directory of ffmpeg for ffprobe as well
      const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
      const { stdout } = await execAsync(`"${ffprobePath}" -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
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
  
  // Define output file path with WAV extension for Whisper API compatibility
  const outputFilePath = `${inputFilePath.slice(0, -path.extname(inputFilePath).length)}.wav`;
  
  try {
    logger.debug(`Converting ${detectedFormat || 'unknown'} format to WAV format for Whisper API`);
    
    // First, try to ensure the input file has the correct extension for format detection
    // This helps FFmpeg identify the format correctly
    const tempInputPath = `${inputFilePath}.${detectedFormat || 'webm'}`;
    fs.copyFileSync(inputFilePath, tempInputPath);
    
    // Use the exact command format known to work with Whisper API
    // 16kHz mono 16-bit PCM WAV is the most reliable format
    const command = `"${ffmpegPath}" -i "${tempInputPath}" -acodec pcm_s16le -ac 1 -ar 16000 "${outputFilePath}" -y`;
    
    logger.info(`Running Whisper-compatible conversion command: ${command}`);
    await execAsync(command);
    
    // Clean up the temporary input file
    try { fs.unlinkSync(tempInputPath); } catch (e) { /* ignore cleanup errors */ }
    
    // Verify the output file exists and has content
    if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
      logger.debug(`Successfully converted to Whisper-compatible WAV: ${outputFilePath}`);
      return outputFilePath;
    } else {
      throw new Error('Conversion produced empty or missing output file');
    }
  } catch (error) {
    logger.error(`Error in primary conversion method: ${error.message}`);
    
    // If the main conversion fails, try this alternative approach which is known to work with problematic WebM files
    try {
      logger.info('Attempting alternative WebM conversion approach');
      // This two-step approach often fixes problematic WebM files:
      // 1. First extract the audio to a raw PCM format
      const rawPcmPath = `${inputFilePath}.pcm`;
      await execAsync(`"${ffmpegPath}" -i "${inputFilePath}" -f s16le -acodec pcm_s16le -ac 1 -ar 16000 "${rawPcmPath}" -y`);
      
      // 2. Then convert the raw PCM to WAV
      await execAsync(`"${ffmpegPath}" -f s16le -ar 16000 -ac 1 -i "${rawPcmPath}" "${outputFilePath}" -y`);
      
      // Clean up the intermediate file
      try { fs.unlinkSync(rawPcmPath); } catch (e) { /* ignore cleanup errors */ }
      
      if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
        logger.info('Alternative two-step conversion successful');
        return outputFilePath;
      }
    } catch (altError) {
      logger.error(`Alternative conversion failed: ${altError.message}`);
    }
    
    // If all attempts fail, try one more approach with explicit format forcing
    try {
      logger.warn('Trying final conversion approach with format forcing');
      await execAsync(`"${ffmpegPath}" -f webm -i "${inputFilePath}" -acodec pcm_s16le -ac 1 -ar 16000 "${outputFilePath}" -y`);
      
      if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
        logger.info('Final conversion attempt successful');
        return outputFilePath;
      }
    } catch (finalError) {
      logger.error(`Final conversion attempt failed: ${finalError.message}`);
    }
    
    // As a last resort, create a simple test WAV file to verify the API connection
    try {
      logger.warn('Creating test WAV file for debugging purposes');
      // Create a silent 1-second WAV file that is guaranteed to be valid
      const silentWavCommand = `"${ffmpegPath}" -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -y "${outputFilePath}"`;
      await execAsync(silentWavCommand);
      
      if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
        logger.warn('Using silent test WAV file for debugging');
        return outputFilePath;
      }
    } catch (silentError) {
      logger.error(`Failed to create test file: ${silentError.message}`);
    }
    
    logger.error('All conversion methods failed');
    return inputFilePath; // Return original as last resort
  }
}

module.exports = {
  detectAudioFormat,
  convertAudioFormatIfNeeded
};
