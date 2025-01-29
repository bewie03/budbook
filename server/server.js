const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const fs = require('fs').promises;

dotenv.config();

const app = express();

// Trust proxy - required for Heroku
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
const REQUIRED_PAYMENT = 10000000; // 10 ADA in lovelace

// Initialize caches
const walletCache = new NodeCache({ stdTTL: 300 }); // 5 minutes for wallet data
const transactionCache = new NodeCache({ stdTTL: 86400 }); // 24 hours for processed transactions

// Permanent asset cache file path
const ASSET_CACHE_FILE = path.join(__dirname, 'asset_cache.json');

// In-memory asset cache
let assetCache = {};

// Load asset cache from file on startup
async function loadAssetCache() {
    try {
        const data = await fs.readFile(ASSET_CACHE_FILE, 'utf8');
        assetCache = JSON.parse(data);
        console.log(`Loaded ${Object.keys(assetCache).length} assets from cache file`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No existing asset cache file, starting fresh');
            assetCache = {};
            // Create the file
            await fs.writeFile(ASSET_CACHE_FILE, JSON.stringify({}));
        } else {
            console.error('Error loading asset cache:', error);
        }
    }
}

// Save asset cache to file
async function saveAssetCache() {
    try {
        await fs.writeFile(ASSET_CACHE_FILE, JSON.stringify(assetCache));
    } catch (error) {
        console.error('Error saving asset cache:', error);
    }
}

// Load cache on startup
loadAssetCache();

// Save cache periodically (every 5 minutes)
setInterval(() => {
    saveAssetCache();
}, 5 * 60 * 1000);

// Save cache on process exit
process.on('SIGINT', async () => {
    console.log('Saving asset cache before exit...');
    await saveAssetCache();
    process.exit();
});

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

async function getAssetInfo(assetId) {
    try {
        // Check in-memory cache first
        if (assetCache[assetId]) {
            console.log(`Using cached data for asset ${assetId}`);
            return assetCache[assetId];
        }

        // If not in cache, fetch from Blockfrost
        console.log(`Fetching asset data for ${assetId}`);
        const assetData = await fetchBlockfrost(`/assets/${assetId}`, 'fetch asset data');
        
        // Get decimals from metadata or onchain_metadata
        let decimals = 0;
        if (assetData.metadata?.decimals !== undefined) {
            decimals = parseInt(assetData.metadata.decimals);
        } else if (assetData.onchain_metadata?.decimals !== undefined) {
            decimals = parseInt(assetData.onchain_metadata.decimals);
        }
        
        // Process the asset data
        const processedData = {
            metadata: assetData.metadata || null,
            onchain_metadata: assetData.onchain_metadata || null,
            decimals: decimals,
            asset_name: assetData.asset_name ? 
                Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                assetId.substring(56),
            policy_id: assetId.substring(0, 56),
            fingerprint: assetData.fingerprint,
            display_name: assetData.onchain_metadata?.name || 
                        assetData.metadata?.name || 
                        (assetData.asset_name ? Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                        assetId.substring(56))
        };

        console.log(`Asset ${assetId} decimals:`, decimals);
        
        // Store in cache
        assetCache[assetId] = processedData;
        
        // Save cache to file
        await saveAssetCache();
        
        return processedData;
    } catch (error) {
        console.error(`Error fetching asset info for ${assetId}:`, error);
        return null;
    }
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const address = req.params.address;
    console.log('Fetching wallet data for:', address);
    
    // Always fetch fresh address data
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
            // Always fetch fresh asset data to ensure we have latest decimals
            const assetData = await fetchBlockfrost(`/assets/${asset.unit}`, 'fetch asset data');
            
            // Get decimals from metadata or onchain_metadata
            let decimals = 0;
            if (assetData.metadata?.decimals !== undefined) {
                decimals = parseInt(assetData.metadata.decimals);
            } else if (assetData.onchain_metadata?.decimals !== undefined) {
                decimals = parseInt(assetData.onchain_metadata.decimals);
            }
            
            const processedData = {
                metadata: assetData.metadata || null,
                onchain_metadata: assetData.onchain_metadata || null,
                decimals: decimals,
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
            
            // Update cache with fresh data
            assetCache[asset.unit] = processedData;
            await saveAssetCache();
            
            return {
              ...asset,
              ...processedData
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
      details: error.response ? await error.response.text() : null
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

// Add endpoint to view cache
app.get('/api/cache', (req, res) => {
  try {
    const cacheStats = {
      assetCacheSize: Object.keys(assetCache).length,
      walletCacheSize: walletCache.keys().length,
      transactionCacheSize: transactionCache.keys().length,
      assetCache: assetCache
    };
    res.json(cacheStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
