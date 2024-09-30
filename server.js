const express = require('express');
const admin = require('firebase-admin'); // Firebase Admin SDK
const app = express();
const PORT = process.env.PORT || 3000; // Use the environment variable PORT if defined
require('dotenv').config();

// Determine if running locally or in Render


// Read the Firebase service account key from an environment variable
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

// Store the latest sensor data in memory
let sensorData = {
    distance: 0
};

// Endpoint to receive sensor data from MicroPython
app.post('/sensor-data', (req, res) => {
    const { distance } = req.body;

    if (typeof distance === 'number') {
        sensorData.distance = distance;
        console.log(`Received distance: ${distance} cm`);

        // Reference to the specific path for Gym/Bin-1 under Trash-Bins
        const binRef = sensorDataRef.child('Gym/Bin-1');

        // Save to Firebase
        binRef.set({ // Use set to overwrite existing data
            _id: 1, // Replace with dynamic ID generation if needed
            distance: distance
        })
            .then(() => {
                console.log('Data saved to Firebase:', { _id: 1, distance: distance });
                res.status(200).send('Data received and saved to Firebase');
            })
            .catch((error) => {
                console.error('Error saving to Firebase:', error);
                res.status(500).send('Failed to save data to Firebase');
            });
    } else {
        res.status(400).send('Invalid data format');
    }
});

// Endpoint to fetch the latest sensor data (optional for debugging)
app.get('/latest-distance', (req, res) => {
    res.status(200).json(sensorData);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});