const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const fs = require('fs').promises;
const crypto = require('crypto');
const Redis = require('ioredis');

dotenv.config();

const app = express();

// Trust proxy - required for Heroku
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
const REQUIRED_PAYMENT = 2000000; // 2 ADA in lovelace
const BLOCKFROST_WEBHOOK_ID = process.env.BLOCKFROST_WEBHOOK_ID;
const BLOCKFROST_WEBHOOK_TOKEN = process.env.BLOCKFROST_WEBHOOK_TOKEN;

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

// Redis client setup
const redisUrl = (process.env.REDIS_URL || process.env.REDISCLOUD_URL || '').replace('rediss://', 'redis://');
console.log('Connecting to Redis URL (without sensitive info):', redisUrl.replace(/\/\/.*@/, '//<credentials>@'));

const redis = new Redis(redisUrl, {
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
  connectTimeout: 10000,
  disconnectTimeout: 2000
});

redis.on('error', err => {
  console.error('Redis Client Error:', err);
  console.error('Full error:', JSON.stringify(err, null, 2));
});

redis.on('connect', () => {
  console.log('Connected to Redis Cloud');
});

redis.on('ready', () => {
  console.log('Redis client is ready');
});

redis.on('reconnecting', () => {
  console.log('Redis client is reconnecting...');
});

// Test Redis connection
(async () => {
  try {
    await redis.set('test', 'working');
    const testResult = await redis.get('test');
    console.log('Redis test result:', testResult);
  } catch (error) {
    console.error('Failed to test Redis:', error);
  }
})();

// Helper functions for Redis
async function getFromCache(key) {
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.error('Error getting from cache:', error);
    return null;
  }
}

async function setInCache(key, value, expirySeconds = null) {
  try {
    if (expirySeconds) {
      await redis.setex(key, expirySeconds, JSON.stringify(value));
    } else {
      await redis.set(key, JSON.stringify(value));
    }
    return true;
  } catch (error) {
    console.error('Error setting cache:', error);
    return false;
  }
}

async function getAssetMetadata(assetId) {
  const cacheKey = `asset:${assetId}`;
  
  // Try to get from cache first
  const cachedData = await getFromCache(cacheKey);
  if (cachedData) {
    console.log(`Cache hit for asset ${assetId}`);
    return cachedData;
  }

  try {
    // Fetch metadata from Blockfrost
    const [assetData, assetDetails] = await Promise.all([
      // Get basic asset data
      fetch(`${BLOCKFROST_BASE_URL}/assets/${assetId}`, {
        headers: { 'project_id': BLOCKFROST_PROJECT_ID }
      }).then(res => res.json()),
      
      // Get detailed metadata including decimals
      fetch(`${BLOCKFROST_BASE_URL}/assets/${assetId}/metadata`, {
        headers: { 'project_id': BLOCKFROST_PROJECT_ID }
      }).then(res => res.json())
    ]);

    // Combine the data
    const data = {
      ...assetData,
      decimals: assetDetails.decimals,
      metadata: assetDetails
    };

    console.log(`Caching metadata for asset ${assetId}:`, data);
    
    // Cache the metadata permanently since it's immutable on Cardano
    await redis.set(cacheKey, JSON.stringify(data));
    
    return data;
  } catch (error) {
    console.error('Error fetching asset metadata:', error);
    throw error;
  }
}

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
      '/api/verify-payment/:paymentId': 'Verify payment for slot unlock'
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
        'project_id': BLOCKFROST_PROJECT_ID
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
    const { address } = req.params;
    
    // Fetch basic wallet data
    const walletData = await fetchBlockfrost(`/addresses/${address}`, 'fetch wallet data');
    
    // If wallet has assets, fetch their metadata
    if (walletData.amount && walletData.amount.length > 0) {
      const assets = [];
      
      // Process each asset
      for (const asset of walletData.amount) {
        if (asset.unit !== 'lovelace') {
          try {
            // Get metadata from cache or Blockfrost
            const metadata = await getAssetMetadata(asset.unit);
            assets.push({
              ...metadata,
              quantity: asset.quantity
            });
          } catch (error) {
            console.error(`Error fetching metadata for asset ${asset.unit}:`, error);
            // Include basic asset info even if metadata fetch fails
            assets.push({
              unit: asset.unit,
              quantity: asset.quantity
            });
          }
        }
      }
      
      // Add processed assets to response
      walletData.assets = assets;
    }

    res.json(walletData);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// Payment initiation endpoint
app.post('/api/initiate-payment', express.json(), async (req, res) => {
  try {
    const { installId } = req.body;
    
    if (!installId) {
      return res.status(400).json({ error: 'Installation ID is required' });
    }

    // Generate random ADA amount between 2-3
    const amount = (2 + Math.random()).toFixed(2);
    const paymentId = crypto.randomUUID();
    
    // Store payment details with installation ID
    const payment = {
      paymentId,
      installId,
      amount,
      timestamp: Date.now(),
      verified: false,
      used: false
    };
    
    // Cache for 1 hour
    await setInCache(`payment:${paymentId}`, payment, 3600);
    
    // Also store by installation ID for quick lookup
    await setInCache(`install_payment:${installId}`, paymentId, 3600);
    
    console.log('Payment initiated:', payment);
    
    res.json({
      paymentId,
      amount,
      address: PAYMENT_ADDRESS
    });
  } catch (error) {
    console.error('Error initiating payment:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// Payment verification endpoint
app.get('/api/verify-payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const payment = await getFromCache(`payment:${paymentId}`);

    if (!payment) {
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    if (payment.verified) {
      if (payment.used) {
        return res.json({ verified: true, used: true });
      }
      // Mark payment as used
      payment.used = true;
      await setInCache(`payment:${paymentId}`, payment);
      // Remove the installation ID payment reference
      await redis.del(`install_payment:${payment.installId}`);
      return res.json({ verified: true, used: false });
    }

    // Get recent transactions
    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`, {
      headers: { 'project_id': BLOCKFROST_PROJECT_ID }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch transactions');
    }

    const transactions = await response.json();

    // Check recent transactions for the exact amount
    for (const tx of transactions) {
      const txResponse = await fetch(`${BLOCKFROST_BASE_URL}/txs/${tx.tx_hash}/utxos`, {
        headers: { 'project_id': BLOCKFROST_PROJECT_ID }
      });

      if (!txResponse.ok) continue;

      const txData = await txResponse.json();
      
      // Calculate total ADA sent to our address in this transaction
      const amountReceived = txData.outputs
        .filter(output => output.address === PAYMENT_ADDRESS)
        .reduce((sum, output) => {
          return sum + (parseInt(output.amount[0].quantity) / 1000000); // Convert lovelace to ADA
        }, 0);

      // Check if amount matches exactly
      if (Math.abs(amountReceived - parseFloat(payment.amount)) < 0.000001) {
        payment.verified = true;
        await setInCache(`payment:${paymentId}`, payment);
        console.log('Payment verified for ID:', paymentId, 'Installation:', payment.installId);
        return res.json({ verified: true, used: false });
      }
    }

    res.json({ verified: false });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Webhook endpoint for payment verification
app.post('/webhook', express.json(), async (req, res) => {
  try {
    // Verify webhook authenticity
    const webhookId = req.headers['blockfrost-webhook-id'];
    const signature = req.headers['blockfrost-signature'];
    
    if (!webhookId || webhookId !== BLOCKFROST_WEBHOOK_ID) {
      console.error('Invalid webhook ID');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!signature || signature !== BLOCKFROST_WEBHOOK_TOKEN) {
      console.error('Invalid signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = req.body;
    console.log('Received webhook payload:', payload);

    // Extract transaction details
    const tx = payload.payload;
    if (!tx || !tx.outputs) {
      console.error('Invalid webhook payload');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Find the output to our payment address
    const paymentOutput = tx.outputs.find(output => output.address === PAYMENT_ADDRESS);
    if (!paymentOutput) {
      console.error('No payment to verification address found');
      return res.status(400).json({ error: 'No relevant payment found' });
    }

    // Calculate amount in ADA
    const amountAda = parseInt(paymentOutput.amount[0].quantity) / 1000000;
    console.log('Payment received:', amountAda, 'ADA');

    // Get all payment keys from Redis
    const keys = await redis.keys('payment:*');
    
    // Check each payment for matching amount
    for (const key of keys) {
      const payment = await getFromCache(key);
      if (payment && Math.abs(parseFloat(payment.amount) - amountAda) < 0.000001) { // Account for floating point precision
        payment.verified = true;
        await setInCache(key, payment);
        console.log('Payment verified for ID:', key.split(':')[1]);
        break;
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add endpoint to view cache
app.get('/api/cache', async (req, res) => {
  try {
    // Get all keys from Redis
    const keys = await redis.keys('*');
    const cacheData = {};

    // Get data for each key
    for (const key of keys) {
      const value = await redis.get(key);
      try {
        cacheData[key] = JSON.parse(value);
      } catch (e) {
        cacheData[key] = value;
      }
    }

    // Group by type
    const groupedCache = {
      assets: {},
      payments: {},
      other: {}
    };

    for (const [key, value] of Object.entries(cacheData)) {
      if (key.startsWith('asset:')) {
        groupedCache.assets[key] = value;
      } else if (key.startsWith('payment:')) {
        groupedCache.payments[key] = value;
      } else {
        groupedCache.other[key] = value;
      }
    }

    res.json({
      totalKeys: keys.length,
      groupedCache
    });
  } catch (error) {
    console.error('Error viewing cache:', error);
    res.status(500).json({ error: 'Failed to view cache' });
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
