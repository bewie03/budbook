const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;

// Configure CORS for Chrome extension
app.use(cors({
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Serve favicon
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'));
});

// Root route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Cardano Address Book API Server',
    endpoints: {
      '/api/wallet/:address': 'Get wallet information',
      '/api/verify-payment/:address': 'Verify payment for slot unlock'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Middleware to verify origin
// app.use((req, res, next) => {
//   const origin = req.get('origin');
//   // Only allow requests from Chrome extension
//   if (origin && origin.startsWith('chrome-extension://')) {
//     next();
//   } else {
//     res.status(403).json({ error: 'Unauthorized origin' });
//   }
// });

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    console.log('Fetching wallet data for:', req.params.address);
    
    if (!BLOCKFROST_API_KEY) {
      throw new Error('BLOCKFROST_API_KEY not configured');
    }

    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${req.params.address}`, {
      headers: {
        'project_id': BLOCKFROST_API_KEY
      }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(error.message || `HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Wallet data:', data);
    res.json(data);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Verify payment for slot unlock
app.get('/api/verify-payment/:address', async (req, res) => {
  try {
    console.log('Verifying payment from:', req.params.address);
    
    if (!BLOCKFROST_API_KEY) {
      throw new Error('BLOCKFROST_API_KEY not configured');
    }

    if (!PAYMENT_ADDRESS) {
      throw new Error('PAYMENT_ADDRESS not configured');
    }

    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`, {
      headers: {
        'project_id': BLOCKFROST_API_KEY
      }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(error.message || `HTTP error! status: ${response.status}`);
    }
    
    const transactions = await response.json();
    console.log('Transaction data:', transactions);
    
    // Find transaction from the user's address
    const userTx = transactions.find(tx => tx.from === req.params.address);
    
    if (userTx && userTx.amount === 10000000) { // 10 ADA in lovelace
      res.json({ verified: true });
    } else {
      res.json({ verified: false });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message,
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('Blockfrost API configured:', !!BLOCKFROST_API_KEY);
  console.log('Payment address configured:', !!PAYMENT_ADDRESS);
});
