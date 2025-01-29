const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
const REQUIRED_PAYMENT = 10000000; // 10 ADA in lovelace

// Initialize cache with 5 minute TTL
const walletCache = new NodeCache({ stdTTL: 300 });

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

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

async function fetchBlockfrost(endpoint, errorContext = '') {
  try {
    if (!BLOCKFROST_API_KEY) {
      throw new Error('BLOCKFROST_API_KEY not configured');
    }

    const response = await fetch(`${BLOCKFROST_BASE_URL}${endpoint}`, {
      headers: {
        'project_id': BLOCKFROST_API_KEY
      }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      
      // Handle specific Blockfrost error codes
      switch (response.status) {
        case 400:
          throw new Error('Invalid address format');
        case 402:
          throw new Error('Project exceeded daily request limit');
        case 403:
          throw new Error('Invalid project token');
        case 404:
          throw new Error('Address not found');
        case 418:
          throw new Error('IP has been auto-banned for extensive sending of requests');
        case 429:
          throw new Error('Too many requests');
        case 500:
          throw new Error('Internal Blockfrost error');
        default:
          throw new Error(error.message || `HTTP error! status: ${response.status}`);
      }
    }
    
    return await response.json();
  } catch (error) {
    console.error(`Error in Blockfrost API call (${errorContext}):`, error);
    throw error;
  }
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const address = req.params.address;
    console.log('Fetching wallet data for:', address);
    
    // Check cache first
    const cachedData = walletCache.get(address);
    if (cachedData) {
      console.log('Returning cached data for:', address);
      return res.json(cachedData);
    }
    
    // Fetch address data
    const addressData = await fetchBlockfrost(`/addresses/${address}`, 'fetch wallet data');
    console.log('Address data:', addressData);
    
    // Extract lovelace (ADA) amount from the amounts array
    const lovelaceAmount = addressData.amount?.find(amt => amt.unit === 'lovelace')?.quantity || '0';
    
    // Get other assets and fetch their metadata
    const assets = addressData.amount?.filter(amt => amt.unit !== 'lovelace') || [];
    const assetsWithMetadata = await Promise.all(
      assets.map(async (asset) => {
        try {
          // For non-native tokens, get the asset details
          if (asset.unit.length > 32) {
            const assetData = await fetchBlockfrost(`/assets/${asset.unit}`, 'fetch asset metadata');
            return {
              ...asset,
              metadata: assetData.metadata || null,
              onchain_metadata: assetData.onchain_metadata || null,
              decimals: assetData.metadata?.decimals || assetData.onchain_metadata?.decimals || 0,
              asset_name: assetData.asset_name ? 
                Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                asset.unit.substring(56),
              policy_id: asset.unit.substring(0, 56),
              fingerprint: assetData.fingerprint,
              display_name: assetData.onchain_metadata?.name || 
                          assetData.metadata?.name || 
                          (assetData.asset_name ? Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                          asset.unit.substring(56))
            };
          }
          return asset;
        } catch (error) {
          console.error('Error fetching asset metadata:', error);
          return asset;
        }
      })
    );
    
    // Format response
    const response = {
      address: addressData.address,
      balance: lovelaceAmount,
      stake_address: addressData.stake_address,
      assets: assetsWithMetadata
    };
    
    // Cache the result
    walletCache.set(address, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(error.message.includes('not found') ? 404 : 500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Verify payment for slot unlock
app.get('/api/verify-payment/:address', async (req, res) => {
  try {
    const userAddress = req.params.address;
    console.log('Verifying payment from:', userAddress);
    
    if (!PAYMENT_ADDRESS) {
      throw new Error('PAYMENT_ADDRESS not configured');
    }

    // Get transactions for the payment address
    const transactions = await fetchBlockfrost(
      `/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`,
      'verify payment'
    );
    console.log('Transaction data:', transactions);
    
    // Find transaction from the user's address within last 24 hours
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const recentTx = transactions.find(tx => {
      const txTime = new Date(tx.block_time * 1000).getTime();
      return tx.from === userAddress && 
             tx.amount === REQUIRED_PAYMENT &&
             txTime > oneDayAgo;
    });
    
    if (recentTx) {
      res.json({ 
        verified: true,
        txHash: recentTx.tx_hash,
        amount: recentTx.amount
      });
    } else {
      res.json({ 
        verified: false,
        reason: 'No matching payment found in the last 24 hours'
      });
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
