// Import required modules
const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const Joi = require('joi');
const morgan = require('morgan');
const helmet = require('helmet');
const dotenv = require('dotenv');
const http = require('http');
const WebSocket = require('ws');
const winston = require('winston');
const rateLimit = require('express-rate-limit');

// Load environment variables
dotenv.config();

// Configure colors for log levels
winston.addColors({
    error: 'bold red',
    warn: 'italic yellow',
    info: 'green',
    http: 'cyan',
    debug: 'magenta',
});

// Configure Winston logger with colors
const logger = winston.createLogger({
    level: 'info',
    levels: winston.config.npm.levels,
    format: winston.format.combine(
        winston.format.colorize(),  // Apply colors to log levels
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...metadata }) => {
            let msg = `${timestamp} [${level}]: ${message} `;
            if (metadata) {
                msg += JSON.stringify(metadata);
            }
            return msg;
        })
    ),
    transports: [
        new winston.transports.Console(),
    ]
});

// Determine if running locally or in Render
let serviceAccount;
try {
    serviceAccount = process.env.RENDER === 'true'
        ? '/etc/secrets/serviceAccountKey.json' // Path for Render
        : process.env.FIREBASE_SERVICE_ACCOUNT_KEY; // Path for local
} catch (error) {
    console.error("Error parsing Firebase service account key:", error);
    process.exit(1); // Exit if there's an error
}

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Get reference to Firebase Realtime Database
const db = admin.database();
const sensorDataRef = db.ref('Trash-Bins');

// Initialize Express app
const app = express();

// Apply middleware
app.use(helmet());  // Enhance API security
app.use(bodyParser.json());  // Parse JSON request bodies
app.use(morgan('combined'));  // HTTP request logging

// Configure rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Define Joi validation schemas
const distanceSchema = Joi.object({
    type: Joi.string().valid('distance').required(), // Add this line
    id: Joi.number().required(),
    distance: Joi.number().required(),
    location: Joi.string().required(),
    microProcessor_status: Joi.string().required(),
    sensor_status: Joi.string().required(),
    binLid_status: Joi.string().required()
});

const binSchema = Joi.object({
    id: Joi.number().required(),
    location: Joi.string().required(),
    binColor: Joi.string().required(),
    geoLocation: Joi.string().optional().allow('')
});

// Endpoint to create bin
app.post('/create-bin', async (req, res) => {
    // Validate incoming data
    const { error } = binSchema.validate(req.body);
    if (error) {
        logger.error('Validation error:', error.details);
        return res.status(400).json({ error: 'Invalid data format or missing required fields' });
    }

    const { id, location, binColor, geoLocation } = req.body;
    logger.info(`Received metadata for location: ${location}`);

    const binRef = sensorDataRef.child(`${location}/Bin-${id}`);

    try {
        // Fetch existing distance data if it exists
        const distanceSnapshot = await binRef.once('value');
        const distanceData = distanceSnapshot.val();

        const dataToSave = {
            _id: id,
            location: location,
            binColor,
            geoLocation: geoLocation || null,
            distance: distanceData ? distanceData.distance : 0,
            microProcessor_status: distanceData ? distanceData.microProcessor_status : "OFF",
            sensor_status: distanceData ? distanceData.sensor_status : "OFF",
            binLid_status: distanceData ? distanceData.binLid_status : "CLOSE",
            lastUpdated: distanceData && distanceData.lastUpdated ? distanceData.lastUpdated : new Date().toLocaleString(),
        };

        // Save data to Firebase
        await binRef.set(dataToSave);
        logger.info('Metadata saved to Firebase:', dataToSave);
        res.status(200).json({ message: 'Bin metadata received and saved to Firebase' });
    } catch (error) {
        logger.error('Error saving metadata to Firebase:', error);
        res.status(500).json({ error: 'Failed to save bin metadata to Firebase' });
    }
});

// Set up WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    logger.info('New WebSocket connection established');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Route messages based on their type
            switch (data.type) {
                case 'distance':
                    await handleDistanceMessage(ws, data);
                    break;
                default:
                    ws.send(JSON.stringify({ error: 'Unknown message type' }));
                    logger.warn(`Received unknown message type: ${data.type}`);
                    break;
            }
        } catch (e) {
            logger.error('Error processing WebSocket message:', e);
            ws.send(JSON.stringify({ error: 'Invalid data format' }));
        }
    });

    ws.on('close', () => {
        logger.info('WebSocket connection closed');
    });
});

// Handle distance update messages
async function handleDistanceMessage(ws, data) {
    // Log the received message for debugging
    logger.info('Received distance message:', data);

    // Validate incoming data using the distanceSchema
    const { error } = distanceSchema.validate(data);
    if (error) {
        logger.error('Invalid distance data:', error.details);
        ws.send(JSON.stringify({ error: 'Invalid distance data', details: error.details }));
        return;
    }

    const { id, distance, location, sensor_status, microProcessor_status, binLid_status } = data;
    const binRef = sensorDataRef.child(`${location}/Bin-${id}`);
    const now = new Date();
    const formattedDate = now.toLocaleString();

    try {
        // Check if existing data for the given id and location exists
        const existingDataSnapshot = await binRef.once('value');
        const existingData = existingDataSnapshot.val();

        if (!existingData) {
            // Send error message if the id and location do not exist
            logger.error(`No existing data found for Bin-${id} at ${location}`);
            ws.send(JSON.stringify({ error: 'No existing data found for this bin' }));
            return;
        }

        // Proceed to save new data
        const dataToSave = {
            ...existingData,
            distance,
            microProcessor_status,
            sensor_status,
            binLid_status,
            lastUpdated: formattedDate
        };

        await binRef.set(dataToSave);
        ws.send(JSON.stringify({ status: 'distance_updated' }));
        logger.info(`Distance updated for Bin-${id} at ${location}: ${distance} cm`);
    } catch (error) {
        logger.error(`Error updating distance for Bin-${id}:`, error);
        ws.send(JSON.stringify({ error: 'Failed to update distance' }));
    }
}

// Global error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info('Server running on:', {
        HTTP: `http Post Request://localhost:${PORT}/create-bin`,
        Web_Socket: `ws://localhost:${PORT}`
    });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received. Closing HTTP server.');
    server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
    });
});

