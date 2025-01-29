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
        headers: { 'project_id': BLOCKFROST_API_KEY }
      }).then(res => res.json()),
      
      // Get detailed metadata including decimals
      fetch(`${BLOCKFROST_BASE_URL}/assets/${assetId}/metadata`, {
        headers: { 'project_id': BLOCKFROST_API_KEY }
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
    console.log(`Fetching from Blockfrost: ${endpoint}`);
    const response = await fetch(`${BLOCKFROST_BASE_URL}${endpoint}`, {
      headers: { 
        'project_id': BLOCKFROST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`Blockfrost API error (${errorContext}):`, {
        status: response.status,
        statusText: response.statusText,
        error: errorData
      });
      
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please try again in a few minutes.');
      } else if (response.status === 403) {
        throw new Error('API key invalid or unauthorized.');
      } else if (response.status === 404) {
        throw new Error('Resource not found.');
      } else {
        throw new Error(`Blockfrost API error (${response.status}): ${errorData.message || response.statusText}`);
      }
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error in Blockfrost API call (${errorContext}):`, error);
    throw new Error(`Failed to ${errorContext}: ${error.message}`);
  }
}

// Helper to validate Cardano address format
function isValidCardanoAddress(address) {
  // Shelley addresses start with addr1 and are 58+ chars
  const shelleyRegex = /^addr1[a-zA-Z0-9]{58,}$/;
  // Byron addresses start with Ae2 or Dd and are 58+ chars
  const byronRegex = /^(Ae2|DdzFF)[a-zA-Z0-9]{58,}$/;
  return shelleyRegex.test(address) || byronRegex.test(address);
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    console.log(`Processing wallet request for address: ${address}`);

    // Validate address format first
    if (!isValidCardanoAddress(address)) {
      return res.status(400).json({ 
        error: 'Invalid Cardano address format. Address must be a valid Shelley (addr1...) or Byron (Ae2/DdzFF...) address.'
      });
    }
    
    // Check cache first
    const cached = walletCache.get(address);
    if (cached) {
      console.log(`Returning cached data for ${address}`);
      return res.json(cached);
    }

    // Fetch all wallet data in parallel
    console.log(`Fetching wallet data from Blockfrost for ${address}`);
    const walletData = await fetchBlockfrost(`/addresses/${address}`, 'fetch wallet data');

    console.log('Wallet data response:', JSON.stringify(walletData, null, 2));

    // Process assets data
    const assets = [];
    if (walletData && Array.isArray(walletData.amount)) {
      console.log(`Processing ${walletData.amount.length} assets`);
      for (const token of walletData.amount) {
        try {
          // Skip lovelace entries as they're handled in the balance
          if (token.unit === 'lovelace') continue;

          console.log(`Fetching info for asset: ${token.unit}`);
          const assetInfo = await getAssetInfo(token.unit);
          if (assetInfo) {
            const asset = {
              unit: token.unit,
              quantity: token.quantity,
              decimals: assetInfo.decimals || 0,
              display_name: assetInfo.display_name || assetInfo.name || token.unit,
              ticker: assetInfo.ticker,
              asset_name: assetInfo.asset_name,
              fingerprint: assetInfo.fingerprint,
              onchain_metadata: assetInfo.onchain_metadata || null,
              metadata: assetInfo.metadata || null
            };

            // Calculate readable amount based on decimals
            const amount = parseFloat(token.quantity) / Math.pow(10, asset.decimals);
            asset.readable_amount = amount.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: asset.decimals
            });

            assets.push(asset);
            console.log(`Successfully processed asset: ${asset.display_name}`);
          }
        } catch (error) {
          console.error(`Error processing asset ${token.unit}:`, error);
        }
      }
    }

    // Format response
    const response = {
      address,
      stake_address: walletData.stake_address,
      balance: walletData.amount.find(a => a.unit === 'lovelace') ? 
        (parseInt(walletData.amount.find(a => a.unit === 'lovelace').quantity) / 1000000).toFixed(6) : 
        '0',
      assets: assets.sort((a, b) => b.quantity - a.quantity) // Sort by quantity descending
    };

    console.log('Final response:', JSON.stringify(response, null, 2));

    // Cache response for 5 minutes
    walletCache.set(address, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    const errorMessage = error.response ? 
      `Blockfrost API error: ${error.response.status} - ${error.response.statusText}` :
      'Failed to fetch wallet data';
    console.error('Error details:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

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
    
    // Cache for 10 minutes
    await setInCache(`payment:${paymentId}`, payment, 600);
    
    // Also store by installation ID for quick lookup
    await setInCache(`install_payment:${installId}`, paymentId, 600);
    
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

    // If not verified, just return the current status
    return res.json({ verified: false });

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

// Clear Redis cache
app.post('/api/clear-cache', async (req, res) => {
  try {
    await redis.flushall();
    console.log('Redis cache cleared');
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
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
  console.log('Blockfrost API configured:', !!process.env.BLOCKFROST_API_KEY);
  console.log('Payment address configured:', !!process.env.PAYMENT_ADDRESS);
});
