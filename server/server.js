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

// Initialize Redis client
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

async function getAssetInfo(assetId) {
    try {
        // Check Redis cache first - assets are immutable so cache permanently
        const cachedData = await redis.get(`asset:${assetId}`);
        if (cachedData) {
            console.log(`Using cached data for asset ${assetId}`);
            return JSON.parse(cachedData);
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

        // Process images and metadata
        let imageUrl = null;
        let logoUrl = null;

        // Handle NFT image from onchain metadata
        if (assetData.onchain_metadata?.image) {
            const image = assetData.onchain_metadata.image;
            if (image.startsWith('ipfs://')) {
                imageUrl = `https://ipfs.io/ipfs/${image.slice(7)}`;
            } else if (!image.startsWith('data:')) {
                imageUrl = image;
            }
        }

        // Handle token logo from metadata
        if (assetData.metadata?.logo) {
            const logo = assetData.metadata.logo;
            if (!logo.startsWith('data:')) {
                logoUrl = logo;
            }
        }

        // Filter metadata to remove large fields
        const filteredMetadata = {
            name: assetData.metadata?.name,
            ticker: assetData.metadata?.ticker,
            url: assetData.metadata?.url,
            description: assetData.metadata?.description
        };

        // Filter onchain metadata to remove large fields
        const filteredOnchainMetadata = assetData.onchain_metadata ? {
            name: assetData.onchain_metadata.name,
            description: assetData.onchain_metadata.description,
            image: imageUrl,
            attributes: assetData.onchain_metadata.attributes
        } : null;
        
        // Process the asset data
        const processedData = {
            metadata: filteredMetadata,
            onchain_metadata: filteredOnchainMetadata,
            decimals: decimals,
            asset_name: assetData.asset_name ? 
                Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                assetId.substring(56),
            policy_id: assetId.substring(0, 56),
            fingerprint: assetData.fingerprint,
            ticker: filteredMetadata.ticker,
            display_name: filteredOnchainMetadata?.name || 
                        filteredMetadata.name || 
                        (assetData.asset_name ? Buffer.from(assetData.asset_name, 'hex').toString('utf8') : 
                        assetId.substring(56))
        };

        console.log(`Processed asset ${assetId}:`, {
            display_name: processedData.display_name,
            decimals: processedData.decimals,
            ticker: processedData.ticker,
            has_image: !!imageUrl
        });
        
        // Store in Redis cache PERMANENTLY - no expiry since assets are immutable
        await redis.set(`asset:${assetId}`, JSON.stringify(processedData));
        
        return processedData;
    } catch (error) {
        console.error(`Error getting asset info for ${assetId}:`, error.message);
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
  // Check for basic format
  if (!address || typeof address !== 'string') return false;

  // Mainnet Shelley addresses (addr1...)
  const shelleyMainnetRegex = /^addr1[a-zA-Z0-9]{98}$/;
  
  // Mainnet Byron addresses (Ae2...)
  const byronMainnetRegex = /^(Ae2|DdzFF)[a-zA-Z0-9]{20,100}$/;
  
  // Mainnet stake addresses (stake1...)
  const stakeMainnetRegex = /^stake1[a-zA-Z0-9]{50,60}$/;

  return shelleyMainnetRegex.test(address) || 
         byronMainnetRegex.test(address) || 
         stakeMainnetRegex.test(address);
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    // Validate address format first
    if (!isValidCardanoAddress(address)) {
      console.error(`Invalid address format: ${address}`);
      return res.status(400).json({ 
        error: 'Invalid Cardano address format. Address must be a valid Shelley (addr1...), Byron (Ae2/DdzFF...), or stake (stake1...) address.'
      });
    }

    // Check cache first
    const cached = await redis.get(`wallet:${address}`);
    if (cached) {
      console.log(`Returning cached data for ${address}`);
      return res.json(JSON.parse(cached));
    }

    // Fetch wallet data
    console.log(`Fetching wallet data from Blockfrost for ${address}`);
    let walletData;
    try {
      walletData = await fetchBlockfrost(`/addresses/${address}`, 'fetch wallet data');
    } catch (error) {
      if (error.response?.status === 400) {
        return res.status(400).json({ 
          error: 'Invalid address or network mismatch. Make sure you are using a mainnet Cardano address.'
        });
      }
      throw error;
    }

    // Log only essential wallet data
    console.log('Wallet data:', {
      address: walletData.address,
      stake_address: walletData.stake_address,
      num_assets: walletData.amount?.length || 0,
      ada_balance: walletData.amount?.find(a => a.unit === 'lovelace')?.quantity || '0'
    });

    // Process assets data
    const assets = [];
    if (walletData && Array.isArray(walletData.amount)) {
      console.log(`Processing ${walletData.amount.length} assets`);
      for (const token of walletData.amount) {
        try {
          // Skip lovelace entries as they're handled in the balance
          if (token.unit === 'lovelace') continue;

          console.log(`Processing asset: ${token.unit}`);
          const assetInfo = await getAssetInfo(token.unit);
          if (assetInfo) {
            // Calculate readable amount based on decimals
            const amount = parseFloat(token.quantity) / Math.pow(10, assetInfo.decimals);
            const readable_amount = amount.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: assetInfo.decimals
            });

            const asset = {
              unit: token.unit,
              quantity: token.quantity,
              decimals: assetInfo.decimals || 0,
              display_name: assetInfo.display_name || assetInfo.name || token.unit,
              ticker: assetInfo.ticker,
              asset_name: assetInfo.asset_name,
              fingerprint: assetInfo.fingerprint,
              onchain_metadata: assetInfo.onchain_metadata || null,
              metadata: assetInfo.metadata || null,
              readable_amount
            };

            assets.push(asset);
            console.log(`Processed asset: ${asset.display_name} (${readable_amount} ${asset.ticker || asset.unit})`);
          }
        } catch (error) {
          console.error(`Error processing asset ${token.unit}:`, error.message);
        }
      }
    }

    // Format response
    const response = {
      address,
      stake_address: walletData.stake_address,
      balance: walletData.amount.find(a => a.unit === 'lovelace')?.quantity || '0',
      // Only send essential asset data
      assets: assets.map(asset => ({
        unit: asset.unit,
        quantity: asset.quantity,
        decimals: asset.decimals || 0,
        display_name: asset.display_name,
        ticker: asset.ticker,
        readable_amount: asset.readable_amount
      })).sort((a, b) => {
        // Convert to BigInt for comparison but avoid arithmetic
        const aQuantity = BigInt(a.quantity);
        const bQuantity = BigInt(b.quantity);
        if (aQuantity < bQuantity) return 1;
        if (aQuantity > bQuantity) return -1;
        return 0;
      })
    };

    // Cache the full data in Redis
    const fullData = {
      ...response,
      assets: assets // Store complete asset data
    };
    await redis.set(`wallet:${address}`, JSON.stringify(fullData));

    // Log response size
    console.log('Response size:', JSON.stringify(response).length, 'bytes');
    
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
        const parsed = JSON.parse(value);
        // Filter out large data fields
        if (parsed && typeof parsed === 'object') {
          // For assets, only show essential metadata
          if (key.startsWith('asset:')) {
            cacheData[key] = {
              display_name: parsed.display_name,
              decimals: parsed.decimals,
              ticker: parsed.ticker,
              policy_id: parsed.policy_id,
              fingerprint: parsed.fingerprint,
              has_metadata: !!parsed.metadata,
              has_image: !!(parsed.metadata?.image || parsed.metadata?.logo)
            };
          } else {
            cacheData[key] = parsed;
          }
        } else {
          cacheData[key] = value;
        }
      } catch (e) {
        // If not JSON, store as is
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
