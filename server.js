// Import required modules
const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const Joi = require('joi');
const morgan = require('morgan');
const helmet = require('helmet');
const dotenv = require('dotenv');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { logger } = require('./logger');

// Load environment variables
dotenv.config();

// Check required environment variables
const requiredEnvVars = ['FIREBASE_DATABASE_URL', 'CORS_ORIGINS', 'FIREBASE_SERVICE_ACCOUNT_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        logger.error(`${envVar} is not set in the environment variables.`);
        process.exit(1);
    }
}

// Initialize Firebase Admin SDK
let serviceAccount;
try {
    serviceAccount = process.env.RENDER === 'true'
        ? require('/etc/secrets/serviceAccountKey.json')
        : process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
} catch (error) {
    logger.error("Error parsing Firebase service account key:", error);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Log successful connection to Firebase Realtime Database
logger.info("Connected to Firebase Realtime Database successfully");

// Get reference to Firebase Realtime Database
const firebaseDB = admin.database();
const sensorDataRef = firebaseDB.ref('Trash-Bins');

// Initialize Express app
const app = express();

// Parse the CORS_ORIGINS from the environment variable
const corsOrigins = process.env.CORS_ORIGINS.split(',').map(origin => origin.trim());

// Log the allowed origins for debugging
logger.info("CORS_ORIGINS:", corsOrigins);

// Apply CORS middleware with dynamic origin check
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || corsOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
}));

// Apply middleware
app.use(helmet());
app.use(bodyParser.json());
app.use(morgan('combined'));

// Define user-friendly rate limit configurations
const rateLimits = {
    createBin: { requests: 25, timeFrame: 15 },
    sensorDistance: { requests: 1000, timeFrame: 10 },
    heartbeat: { requests: 2000, timeFrame: 10 },
};

// Define rate limiters for different endpoints
const createBinLimiter = rateLimit({
    windowMs: rateLimits.createBin.timeFrame * 60 * 1000,
    max: rateLimits.createBin.requests,
    message: `Too many requests from this IP, please try again after ${rateLimits.createBin.timeFrame} minute(s).`
});

const sensorDistanceLimiter = rateLimit({
    windowMs: rateLimits.sensorDistance.timeFrame * 60 * 1000,
    max: rateLimits.sensorDistance.requests,
    message: `Too many requests from this IP, please try again after ${rateLimits.sensorDistance.timeFrame} minute(s).`
});

const heartbeatLimiter = rateLimit({
    windowMs: rateLimits.heartbeat.timeFrame * 60 * 1000,
    max: rateLimits.heartbeat.requests,
    message: `Too many heartbeat requests from this IP, please try again after ${rateLimits.heartbeat.timeFrame} minute(s).`
});

// Enhanced monitoring configuration
const MONITORING_CONFIG = {
    checkInterval: 10000,    // Check every 10 seconds
    offlineThreshold: 20000, // Mark as offline after 20 seconds
    cleanupInterval: 3600000 // Cleanup old timestamps every hour
};

// Store for tracking last updates from both endpoints
const deviceStatusTracker = new Map();

// Utility function for formatted date
const getFormattedDate = () => {
    const formattedDate = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Kolkata', // Specify your local time zone
        hour12: true, // Set 12-hour format
    }).format(new Date());

    // Replace lowercase "am" and "pm" with uppercase "AM" and "PM"
    return formattedDate.replace('am', 'AM').replace('pm', 'PM');
};

// Utility function to update device status
const updateDeviceStatus = (binLocation, binId, type) => {
    const deviceKey = `${binLocation}-${binId}`;
    const now = Date.now();

    if (!deviceStatusTracker.has(deviceKey)) {
        deviceStatusTracker.set(deviceKey, {
            lastHeartbeat: 0,
            lastSensorDistance: 0,
            isOnline: false
        });
    }

    const status = deviceStatusTracker.get(deviceKey);
    if (type === 'heartbeat') {
        status.lastHeartbeat = now;
    } else if (type === 'sensor-distance') {
        status.lastSensorDistance = now;
    }
    status.isOnline = true;
};

// Function to check device status
const checkDeviceStatus = async () => {
    const now = Date.now();
    const updates = [];

    for (const [deviceKey, status] of deviceStatusTracker) {
        const [binLocation, binId] = deviceKey.split('-');
        const lastUpdate = Math.max(status.lastHeartbeat, status.lastSensorDistance);

        if (status.isOnline && (now - lastUpdate) > MONITORING_CONFIG.offlineThreshold) {
            status.isOnline = false;

            try {
                // First, get the current data
                const binRef = sensorDataRef.child(`${binLocation}/Bin-${binId}`);
                const snapshot = await binRef.once('value');
                const currentData = snapshot.val();

                if (currentData) {
                    // Only update specific fields
                    const update = {
                        microProcessorStatus: 'OFF',
                        lastUpdated: getFormattedDate(),
                        // Ensure sensor status is also off when microprocessor is off
                        sensorStatus: 'OFF'
                    };

                    await binRef.update(update);
                    logger.info(`Bin-${binId} at ${binLocation} marked as offline`);
                }
            } catch (error) {
                logger.error(`Error updating offline status for Bin-${binId} at ${binLocation}:`, error);
            }
        }
    }
};

// Periodic cleanup of old entries
const cleanupTracker = () => {
    const now = Date.now();
    for (const [deviceKey, status] of deviceStatusTracker) {
        const lastUpdate = Math.max(status.lastHeartbeat, status.lastSensorDistance);
        if (now - lastUpdate > MONITORING_CONFIG.cleanupInterval) {
            deviceStatusTracker.delete(deviceKey);
        }
    }
};

// Define Joi validation schemas
const binMetaDataSchema = Joi.object({
    id: Joi.number().required(),
    binLocation: Joi.string().required(),
    binType: Joi.string().required(),
    geoLocation: Joi.string().allow('').default("latitude,longitude"),
    microProcessorStatus: Joi.string().valid('ON', 'OFF').default('OFF'),
    sensorStatus: Joi.string().valid('ON', 'OFF').default('OFF'),
    binLidStatus: Joi.string().valid('OPEN', 'CLOSE').default('CLOSE'),
    binStatus: Joi.string().valid('active', 'inactive').default('inactive'),
    distance: Joi.number().min(0).default(0),
    filledBinPercentage: Joi.number().min(0).max(100).default(0),
    maxBinCapacity: Joi.number().min(0).default(0)
});

const distanceSchema = Joi.object({
    id: Joi.number().required(),
    binLocation: Joi.string().required(),
    geoLocation: Joi.string().allow('').default("latitude,longitude"),
    microProcessorStatus: Joi.string().valid('ON', 'OFF').required(),
    sensorStatus: Joi.string().valid('ON', 'OFF').required(),
    binLidStatus: Joi.string().valid('OPEN', 'CLOSE').required(),
    distance: Joi.number().min(0).required(),
    filledBinPercentage: Joi.number().min(0).max(100).required(),
    maxBinCapacity: Joi.number().min(0).required()
});

const heartbeatSchema = Joi.object({
    id: Joi.number().required(),
    binLocation: Joi.string().required(),
    microProcessorStatus: Joi.string().valid('ON', 'OFF').required()
});

// Endpoint to create bin
app.post('/create-bin', createBinLimiter, async (req, res) => {
    const { error, value } = binMetaDataSchema.validate(req.body);

    if (error) {
        logger.error('Validation error:', error.details);
        return res.status(400).json({ error: 'Invalid data format or missing required fields' });
    }

    const { id, binLocation } = value;
    logger.info(`Received metadata for location: ${binLocation}`);

    const binRef = sensorDataRef.child(`${binLocation}/Bin-${id}`);

    try {
        const dataToSave = {
            ...value,
            lastUpdated: getFormattedDate(),
            createdAt: getFormattedDate(),
            lastMaintenance: "",
        };

        await binRef.set(dataToSave);
        logger.info('Metadata saved to Firebase:', dataToSave);
        res.status(200).json({ message: 'Bin metadata received and saved to Firebase' });
    } catch (error) {
        logger.error(`Error saving metadata to Firebase for Bin-${id}:`, error);
        res.status(500).json({ error: 'Failed to save bin metadata to Firebase' });
    }
});

// HTTP POST endpoint to handle distance updates
app.post('/sensor-distance', sensorDistanceLimiter, async (req, res) => {
    const { error, value } = distanceSchema.validate(req.body);
    if (error) {
        logger.error('Invalid distance data:', error.details);
        return res.status(400).json({ error: 'Invalid distance data', details: error.details });
    }

    const { id, binLocation } = value;
    const binRef = sensorDataRef.child(`${binLocation}/Bin-${id}`);

    try {
        const existingDataSnapshot = await binRef.once('value');
        const existingData = existingDataSnapshot.val();

        if (!existingData) {
            logger.error(`No existing data found for Bin-${id} at ${binLocation}`);
            return res.status(404).json({ error: 'No existing data found for this bin' });
        }

        const dataToSave = {
            ...existingData,
            ...value,
            lastUpdated: getFormattedDate(),
        };

        await binRef.set(dataToSave);
        updateDeviceStatus(binLocation, id, 'sensor-distance');
        logger.info(`Data updated for Bin-${id} at ${binLocation}`);

        res.status(200).json({ message: 'Bin data updated successfully' });
    } catch (error) {
        logger.error(`Error updating data for Bin-${id}:`, error);
        res.status(500).json({ error: 'Failed to update bin data' });
    }
});

// Heartbeat endpoint
app.post('/sensor-heartbeat', heartbeatLimiter, async (req, res) => {
    const { error, value } = heartbeatSchema.validate(req.body);
    if (error) {
        logger.error('Invalid heartbeat data:', error.details);
        return res.status(400).json({ error: 'Invalid heartbeat data', details: error.details });
    }

    const { id, binLocation, microProcessorStatus } = value;
    const binRef = sensorDataRef.child(`${binLocation}/Bin-${id}`);

    try {
        await binRef.update({
            lastUpdated: getFormattedDate(),
            microProcessorStatus
        });
        updateDeviceStatus(binLocation, id, 'heartbeat');
        res.status(200).json({ message: 'Heartbeat received' });
    } catch (error) {
        logger.error(`Error updating heartbeat for Bin-${id}:`, error);
        res.status(500).json({ error: 'Failed to update heartbeat' });
    }
});

// Start monitoring intervals
setInterval(checkDeviceStatus, MONITORING_CONFIG.checkInterval);
setInterval(cleanupTracker, MONITORING_CONFIG.cleanupInterval);

// Global error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});