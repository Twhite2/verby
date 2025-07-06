const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
fs.ensureDirSync(logsDir);

/**
 * Create a configured logger instance
 * @param {string} module - The module name to include in logs
 * @returns {winston.Logger} - Configured logger instance
 */
function setupLogger(module = 'server') {
  const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    ),
    defaultMeta: { service: 'verbyflow', module },
    transports: [
      // Write all logs with level 'error' and below to error.log
      new winston.transports.File({ 
        filename: path.join(logsDir, 'error.log'), 
        level: 'error' 
      }),
      // Write all logs to combined.log
      new winston.transports.File({ 
        filename: path.join(logsDir, 'combined.log') 
      }),
    ],
  });

  // If not in production, also log to console with color
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => {
          const { timestamp, level, message, module, ...rest } = info;
          const restString = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
          return `${timestamp} [${module}] ${level}: ${message} ${restString}`;
        })
      )
    }));
  }

  return logger;
}

module.exports = {
  setupLogger
};
