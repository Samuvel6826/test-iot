const express = require('express');
const app = express();
const PORT = 3000;

// Middleware to parse incoming JSON requests
app.use(express.json());

// Store the latest sensor data in memory
let sensorData = {
    distance: 0
};

// Endpoint to receive sensor data
app.post('/sensor-data', (req, res) => {
    const { distance } = req.body;

    if (typeof distance === 'number') {
        sensorData.distance = distance;
        console.log(`Received distance: ${distance} cm`);
        res.status(200).send('Data received');
    } else {
        res.status(400).send('Invalid data format');
    }
});

// Endpoint to fetch the latest sensor data
app.get('/latest-distance', (req, res) => {
    res.status(200).json(sensorData);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});