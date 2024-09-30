const express = require('express');
const admin = require('firebase-admin'); // Firebase Admin SDK
const app = express();
const PORT = process.env.PORT || 3000; // Use the environment variable PORT if defined
require('dotenv').config();

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

// Initialize Firebase Admin SDK with the service account credentials
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL // Use the database URL from the environment
});

// Reference to Firebase Realtime Database
const db = admin.database();
const sensorDataRef = db.ref('Trash-Bins'); // Keep the reference to Trash-Bins

// Middleware to parse incoming JSON requests
app.use(express.json());

// Endpoint to receive only distance data from MicroPython
app.post('/sensor-distance', (req, res) => {
    console.log("Distance Request Body:", req.body); // Log the request body
    const { id, distance, location } = req.body;

    // Check if required data is present
    if (typeof distance === 'number' && id && location) {
        console.log(`Received distance: ${distance} cm for location: ${location}`);

        // Reference to the specific path for the location under Trash-Bins
        const binRef = sensorDataRef.child(`${location}/Bin-${id}`); // Dynamic bin name based on id

        // Get the current date and time for lastUpdated
        const now = new Date();
        const formattedDate = now.toLocaleString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: true
        });

        // Save to Firebase
        binRef.set({
            _id: id,
            distance: distance,
            status: distance > 50 ? "ON" : "OFF", // Example logic for status
            lastUpdated: formattedDate,
            location: location,
        })
            .then(() => {
                console.log('Distance data saved to Firebase:', {
                    _id: id,
                    distance: distance,
                    status: distance > 50 ? "ON" : "OFF",
                    lastUpdated: formattedDate,
                    location: location,
                });
                res.status(200).send('Distance data received and saved to Firebase');
            })
            .catch((error) => {
                console.error('Error saving distance to Firebase:', error);
                res.status(500).send('Failed to save distance data to Firebase');
            });
    } else {
        console.error('Invalid data format or missing required fields', req.body);
        res.status(400).send('Invalid data format or missing required fields');
    }
});

// Endpoint to receive bin metadata (ID, location, binColor, geoLocation)
app.post('/bin-metadata', async (req, res) => {
    console.log("Metadata Request Body:", req.body); // Log the request body
    const { id, location, binColor, geoLocation } = req.body;

    // Check if required data is present
    if (id && location && binColor && geoLocation) {
        console.log(`Received metadata for location: ${location}`);

        // Reference to the specific path for the location under Trash-Bins
        const binRef = sensorDataRef.child(`${location}/Bin-${id}`); // Dynamic bin name based on id

        // Fetch existing distance data to see if it exists
        const distanceRef = sensorDataRef.child(`${location}/Bin-${id}`);
        const distanceSnapshot = await distanceRef.once('value');
        const distanceData = distanceSnapshot.val();

        // Prepare data to save
        const dataToSave = {
            _id: id,
            location: location,
            binColor: binColor,
            geoLocation: geoLocation,
            distance: distanceData ? distanceData.distance : 0, // Default value if no distance data
            status: distanceData ? distanceData.status : "OFF", // Default status if no distance data
            lastUpdated: distanceData ? distanceData.lastUpdated : null // Preserve last updated if it exists
        };

        // Save to Firebase
        binRef.set(dataToSave)
            .then(() => {
                console.log('Metadata saved to Firebase:', dataToSave);
                res.status(200).send('Bin metadata received and saved to Firebase');
            })
            .catch((error) => {
                console.error('Error saving metadata to Firebase:', error);
                res.status(500).send('Failed to save bin metadata to Firebase');
            });
    } else {
        console.error('Invalid data format or missing required fields', req.body);
        res.status(400).send('Invalid data format or missing required fields');
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});