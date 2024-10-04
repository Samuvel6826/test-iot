const winston = require('winston');

// Configure colors for log levels
winston.addColors({
    error: 'bold red',
    warn: 'italic yellow',
    info: 'green',
    http: 'cyan',
    debug: 'magenta',
});

// Function to format the timestamp
const formatTimestamp = () => {
    const now = new Date();
    return now.toLocaleString(); // Returns a timestamp in ISO format
};

// Configure Winston logger with colors and formatted timestamp
const logger = winston.createLogger({
    level: 'info',
    levels: winston.config.npm.levels,
    format: winston.format.combine(
        winston.format.colorize(),  // Apply colors to log levels
        winston.format.timestamp({
            format: formatTimestamp // Use the custom format function for the timestamp
        }),
        winston.format.printf(({ timestamp, level, message, ...metadata }) => {
            let msg = `${timestamp} [${level}]: ${message} `;
            if (metadata && Object.keys(metadata).length) { // Only include metadata if it exists
                msg += JSON.stringify(metadata);
            }
            return msg;
        })
    ),
    transports: [
        new winston.transports.Console(),
    ]
});

module.exports = { logger };