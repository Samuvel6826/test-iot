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
const { logger } = require('./logger'); // Import the logger

// Load environment variables
dotenv.config();

// Check required environment variables
if (!process.env.FIREBASE_DATABASE_URL) {
    logger.error("FIREBASE_DATABASE_URL is not set in the environment variables.");
    process.exit(1);
}

// Initialize Firebase Admin SDK
let serviceAccount;
try {
    serviceAccount = process.env.RENDER === 'true'
        ? '/etc/secrets/serviceAccountKey.json' // Path for Render
        : process.env.FIREBASE_SERVICE_ACCOUNT_KEY; // Ensure proper parsing of JSON
} catch (error) {
    logger.error("Error parsing Firebase service account key:", error);
    process.exit(1); // Exit if there's an error
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
const allowedOrigins = process.env.CORS_ORIGINS.split(',');

// Apply CORS middleware with dynamic origin check
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // Check if the origin is in the allowed origins list
        if (allowedOrigins.includes(origin)) {
            return callback(null, true); // Origin is allowed
        } else {
            return callback(new Error('Not allowed by CORS')); // Deny the request
        }
    },
}));

// Apply middleware
app.use(helmet());  // Enhance API security
app.use(bodyParser.json());  // Parse JSON request bodies
app.use(morgan('combined'));  // HTTP request logging

// Define user-friendly rate limit configurations
const rateLimits = {
    createBin: { requests: 25, timeFrame: 15 }, // requests per timeFrame in minutes
    sensorDistance: { requests: 100, timeFrame: 10 },
};

// Define rate limiters for different endpoints
const createBinLimiter = rateLimit({
    windowMs: rateLimits.createBin.timeFrame * 60 * 1000, // Convert minutes to milliseconds
    max: rateLimits.createBin.requests,
    message: `Too many requests from this IP, please try again after ${rateLimits.createBin.timeFrame} minute(s).`
});

const sensorDistanceLimiter = rateLimit({
    windowMs: rateLimits.sensorDistance.timeFrame * 60 * 1000,
    max: rateLimits.sensorDistance.requests,
    message: `Too many requests from this IP, please try again after ${rateLimits.sensorDistance.timeFrame} minute(s).`
});

// Utility function for formatted date
const getFormattedDate = () => {
    return new Date().toLocaleString(); // Format as needed
};

// Define a Joi validation schema for the bin
const binMetaDataSchema = Joi.object({
    id: Joi.number().required(),  // Changed from _id to id
    binLocation: Joi.string().required(),
    binType: Joi.string().required(),
    geoLocation: Joi.string().optional().allow('').default("latitude,longitude"),
    microProcessorStatus: Joi.string().optional().default('OFF'), // Changed to camelCase
    sensorStatus: Joi.string().optional().default('OFF'), // Changed to camelCase
    binLidStatus: Joi.string().optional().default('CLOSE'), // Changed to camelCase
    binStatus: Joi.string().optional().default('inActive'), // Changed to camelCase
    distance: Joi.number().optional().default(0),
    filledBinPercentage: Joi.number().optional().default(0), // Optional, may need to be set later
    maxBinCapacity: Joi.number().optional().default(0) // Optional, may need to be set later
});

// Define Joi validation schemas
const distanceSchema = Joi.object({
    id: Joi.number().required(),
    binLocation: Joi.string().required(),
    geoLocation: Joi.string().optional().allow('').default("latitude,longitude"),
    microProcessorStatus: Joi.string().optional().default('OFF'), // Changed to camelCase
    sensorStatus: Joi.string().optional().default('OFF'), // Changed to camelCase
    binLidStatus: Joi.string().optional().default('CLOSE'), // Changed to camelCase
    distance: Joi.number().required(),
    filledBinPercentage: Joi.number().optional().default(0), // Optional, may need to be set later
    maxBinCapacity: Joi.number().optional().default(0) // Optional, may need to be set later
});

// Endpoint to create bin
app.post('/create-bin', createBinLimiter, async (req, res) => {
    const { error } = binMetaDataSchema.validate(req.body);

    if (error) {
        logger.error('Validation error:', error.details);
        return res.status(400).json({ error: 'Invalid data format or missing required fields' });
    }

    const { id, binLocation, binType, geoLocation } = req.body; // Changed _id to id
    logger.info(`Received metadata for location: ${binLocation}`);

    const binRef = sensorDataRef.child(`${binLocation}/Bin-${id}`);

    try {
        const distanceSnapshot = await binRef.once('value');
        const distanceData = distanceSnapshot.val() || {};

        const dataToSave = {
            _id: id, // Changed _id to id
            binLocation: binLocation,
            binType: binType,
            geoLocation: geoLocation,
            binLidStatus: distanceData.binLidStatus || "CLOSE", // Changed to camelCase
            distance: distanceData.distance || 0,
            filledBinPercentage: 0, // This will be updated based on route data
            maxBinCapacity: 0,
            microProcessorStatus: distanceData.microProcessorStatus || "OFF", // Changed to camelCase
            sensorStatus: distanceData.sensorStatus || "OFF", // Changed to camelCase
            lastUpdated: getFormattedDate(),
            createdAt: getFormattedDate(),
            lastMaintenance: "",
            binStatus: 'inActive',
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
    const { error } = distanceSchema.validate(req.body);
    if (error) {
        logger.error('Invalid distance data:', error.details);
        return res.status(400).json({ error: 'Invalid distance data', details: error.details });
    }

    const { id, distance, filledBinPercentage, binLocation, geoLocation, sensorStatus, microProcessorStatus, binLidStatus, maxBinCapacity } = req.body; // Changed to camelCase
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
            distance,
            filledBinPercentage, // Include filledBinPercentage in updates
            geoLocation,
            microProcessorStatus, // Changed to camelCase
            sensorStatus, // Changed to camelCase
            binLidStatus, // Changed to camelCase
            maxBinCapacity,
            lastUpdated: getFormattedDate()
        };

        await binRef.set(dataToSave);
        logger.info(`Distance updated for Bin-${id} at ${binLocation}: ${distance} cm`);
        res.status(200).json({ message: 'Distance updated successfully' });
    } catch (error) {
        logger.error(`Error updating distance for Bin-${id}:`, error);
        res.status(500).json({ error: 'Failed to update distance' });
    }
});

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