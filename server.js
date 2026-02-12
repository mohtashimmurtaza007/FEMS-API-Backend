// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Helper function: Calculate distance using Haversine formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  
  return distance;
};

// Helper function: Get emission factor based on transport mode and fuel type
const getEmissionFactor = (transportMode, fuelTypes, cooledTransport) => {
  let emissionFactor = 0.1; // Default
  
  switch(transportMode) {
    case 'truck':
      // Base truck emission
      emissionFactor = 0.12;
      
      // Adjust based on fuel type
      const selectedFuels = Object.keys(fuelTypes).filter(key => fuelTypes[key]);
      
      if (selectedFuels.length > 0) {
        const fuelFactors = {
          diesel: 0.12,
          cng: 0.10,
          bev: 0.04,
          hvo: 0.08
        };
        
        const avgFactor = selectedFuels.reduce((sum, fuel) => 
          sum + (fuelFactors[fuel] || 0.12), 0
        ) / selectedFuels.length;
        
        emissionFactor = avgFactor;
      }
      break;
      
    case 'ship':
      emissionFactor = 0.04;
      break;
      
    case 'plane':
      emissionFactor = 0.5;
      break;
      
    case 'train':
      emissionFactor = 0.03;
      break;
      
    case 'intermodal':
      emissionFactor = 0.08;
      break;
      
    default:
      emissionFactor = 0.1;
  }
  
  // Add cooling factor (30% increase)
  if (cooledTransport) {
    emissionFactor *= 1.3;
  }
  
  return emissionFactor;
};

// POST /api/calculate-carbon
app.post('/api/calculate-carbon', async (req, res) => {
  try {
    const {
      userId,
      quantity,
      unit,
      tonnesPerUnit,
      cooledTransport,
      transportMode,
      fuelTypes,
      origin,
      destination,
      originCoords,
      destinationCoords,
      originDetails,
      destinationDetails
    } = req.body;

    // Validation
    if (!quantity || !tonnesPerUnit || !transportMode || !origin || !destination) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    if (!originCoords || !destinationCoords) {
      return res.status(400).json({
        success: false,
        message: 'Origin and destination coordinates are required'
      });
    }

    // Calculate total weight
    const totalWeight = parseFloat(quantity) * parseFloat(tonnesPerUnit);

    // Calculate distance
    const distance = calculateDistance(
      originCoords.lat,
      originCoords.lng,
      destinationCoords.lat,
      destinationCoords.lng
    );

    // Get emission factor
    const emissionFactor = getEmissionFactor(transportMode, fuelTypes || {}, cooledTransport);

    // Calculate carbon footprint
    const carbonFootprint = totalWeight * distance * emissionFactor;

    // Calculate trees needed (1 tree absorbs ~21 kg CO2 per year)
    const treesNeeded = Math.ceil(carbonFootprint / 21);

    // Prepare calculation result
    const calculationData = {
      userId: userId || 'anonymous',
      
      // Input data
      quantity: parseFloat(quantity),
      unit,
      tonnesPerUnit: parseFloat(tonnesPerUnit),
      totalWeight,
      cooledTransport: cooledTransport || false,
      transportMode,
      fuelTypes: fuelTypes || {},
      
      // Location data
      origin,
      destination,
      originCoords,
      destinationCoords,
      originDetails: originDetails || null,
      destinationDetails: destinationDetails || null,
      
      // Calculation results
      distance: parseFloat(distance.toFixed(2)),
      emissionFactor: parseFloat(emissionFactor.toFixed(4)),
      carbonFootprint: parseFloat(carbonFootprint.toFixed(2)),
      treesNeeded,
      
      // Metadata
      calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString()
    };

    // Save to Firestore
    const docRef = await db.collection('emissionCalculations').add(calculationData);

    // Return response
    res.status(200).json({
      success: true,
      message: 'Calculation completed successfully',
      data: {
        id: docRef.id,
        carbonFootprint: calculationData.carbonFootprint,
        totalWeight: calculationData.totalWeight,
        distance: calculationData.distance,
        emissionFactor: calculationData.emissionFactor,
        treesNeeded: calculationData.treesNeeded,
        transportMode: calculationData.transportMode,
        cooledTransport: calculationData.cooledTransport
      }
    });

  } catch (error) {
    console.error('Error calculating carbon footprint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate carbon footprint',
      error: error.message
    });
  }
});

// GET /api/calculations/:userId - Get user's calculation history
app.get('/api/calculations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    const snapshot = await db.collection('emissionCalculations')
      .where('userId', '==', userId)
      .orderBy('calculatedAt', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .get();

    const calculations = [];
    snapshot.forEach(doc => {
      calculations.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.status(200).json({
      success: true,
      data: calculations,
      count: calculations.length
    });

  } catch (error) {
    console.error('Error fetching calculations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch calculations',
      error: error.message
    });
  }
});

// GET /api/calculation/:id - Get single calculation
app.get('/api/calculation/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await db.collection('emissionCalculations').doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Calculation not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: doc.id,
        ...doc.data()
      }
    });

  } catch (error) {
    console.error('Error fetching calculation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch calculation',
      error: error.message
    });
  }
});

// DELETE /api/calculation/:id - Delete calculation
app.delete('/api/calculation/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    // Verify ownership
    const doc = await db.collection('emissionCalculations').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Calculation not found'
      });
    }

    if (doc.data().userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized to delete this calculation'
      });
    }

    await db.collection('emissionCalculations').doc(id).delete();

    res.status(200).json({
      success: true,
      message: 'Calculation deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting calculation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete calculation',
      error: error.message
    });
  }
});

// GET /api/stats/:userId - Get user statistics
app.get('/api/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const snapshot = await db.collection('emissionCalculations')
      .where('userId', '==', userId)
      .get();

    let totalCarbonFootprint = 0;
    let totalDistance = 0;
    let totalWeight = 0;
    let calculationCount = 0;
    const transportModes = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      totalCarbonFootprint += data.carbonFootprint || 0;
      totalDistance += data.distance || 0;
      totalWeight += data.totalWeight || 0;
      calculationCount++;
      
      if (data.transportMode) {
        transportModes[data.transportMode] = (transportModes[data.transportMode] || 0) + 1;
      }
    });

    res.status(200).json({
      success: true,
      data: {
        totalCarbonFootprint: parseFloat(totalCarbonFootprint.toFixed(2)),
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        totalWeight: parseFloat(totalWeight.toFixed(2)),
        calculationCount,
        averageCarbonPerCalculation: calculationCount > 0 
          ? parseFloat((totalCarbonFootprint / calculationCount).toFixed(2)) 
          : 0,
        transportModes,
        treesNeeded: Math.ceil(totalCarbonFootprint / 21)
      }
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
