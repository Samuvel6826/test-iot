const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser'); // For parsing JSON bodies
const Joi = require('joi'); // For input validation
const morgan = require('morgan'); // For logging HTTP requests
const helmet = require('helmet'); // For securing HTTP headers
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK with the service account credentials
const serviceAccount = process.env.RENDER === 'true'
    ? '/etc/secrets/serviceAccountKey.json'
    : process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Reference to Firebase Realtime Database
const db = admin.database();
const sensorDataRef = db.ref('Trash-Bins');

// Middleware for security and logging
app.use(helmet());
app.use(morgan('combined'));
app.use(bodyParser.json());

// Validation schema for sensor distance data
const distanceSchema = Joi.object({
    id: Joi.number().required(),
    distance: Joi.number().required(),
    location: Joi.string().required(),
});

// Validation schema for bin metadata
const metadataSchema = Joi.object({
    id: Joi.number().required(),
    location: Joi.string().required(),
    binColor: Joi.string().required(),
    geoLocation: Joi.string().optional().allow(''), // Allow empty string for geoLocation
});

// Helper function to capitalize the first letter of a string
const capitalizeFirstLetter = (string) => {
    return string.charAt(0).toUpperCase() + string.slice(1).toLowerCase();
};

// Endpoint to receive distance data from MicroPython
app.post('/sensor-distance', async (req, res) => {
    const { error } = distanceSchema.validate(req.body);
    if (error) {
        console.error('Validation error:', error.details);
        return res.status(400).send('Invalid data format or missing required fields');
    }

    const { id, distance, location } = req.body;
    const capitalizedLocation = capitalizeFirstLetter(location);
    console.log(`Received distance: ${distance} cm for location: ${capitalizedLocation}`);

    const binRef = sensorDataRef.child(`${capitalizedLocation}/Bin-${id}`);
    const now = new Date();
    const formattedDate = now.toLocaleString();

    try {
        const existingDataSnapshot = await binRef.once('value');
        const existingData = existingDataSnapshot.val() || {};

        const dataToSave = {
            ...existingData,
            distance,
            status: distance > 50 ? "ON" : "OFF",
            lastUpdated: formattedDate,
            location: capitalizedLocation,
        };

        await binRef.set(dataToSave);
        console.log('Distance data saved to Firebase:', dataToSave);
        res.status(200).send('Distance data received and saved to Firebase');
    } catch (error) {
        console.error('Error saving distance to Firebase:', error);
        res.status(500).send('Failed to save distance data to Firebase');
    }
});

// Endpoint to receive bin metadata
app.post('/bin-metadata', async (req, res) => {
    const { error } = metadataSchema.validate(req.body);
    if (error) {
        console.error('Validation error:', error.details);
        return res.status(400).send('Invalid data format or missing required fields');
    }

    const { id, location, binColor, geoLocation } = req.body;
    const capitalizedLocation = capitalizeFirstLetter(location);
    console.log(`Received metadata for location: ${capitalizedLocation}`);

    const binRef = sensorDataRef.child(`${capitalizedLocation}/Bin-${id}`);

    try {
        // Fetch existing distance data if it exists
        const distanceSnapshot = await sensorDataRef.child(`${capitalizedLocation}/Bin-${id}`).once('value');
        const distanceData = distanceSnapshot.val();

        const dataToSave = {
            _id: id,
            location: capitalizedLocation,
            binColor,
            geoLocation: geoLocation || null, // Allow geoLocation to be null if not provided
            distance: distanceData ? distanceData.distance : 0,
            status: distanceData ? distanceData.status : "OFF",
            lastUpdated: distanceData && distanceData.lastUpdated ? distanceData.lastUpdated : new Date().toLocaleString(), // Set current timestamp if lastUpdated is undefined
        };

        await binRef.set(dataToSave);
        console.log('Metadata saved to Firebase:', dataToSave);
        res.status(200).send('Bin metadata received and saved to Firebase');
    } catch (error) {
        console.error('Error saving metadata to Firebase:', error);
        res.status(500).send('Failed to save bin metadata to Firebase');
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});