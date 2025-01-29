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

function isValidUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    // Remove whitespace
    url = url.trim();
    
    // Handle IPFS URLs
    if (url.startsWith('ipfs://')) {
        const ipfsHash = url.slice(7).replace(/^\/+|\/+$/g, '');
        return `https://ipfs.io/ipfs/${ipfsHash}`;
    }
    
    // Convert HTTP to HTTPS
    if (url.startsWith('http://')) {
        url = `https://${url.slice(7)}`;
    }
    
    // Ensure HTTPS
    if (!url.startsWith('https://')) return null;
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol && parsed.host) return url;
    } catch {
        return null;
    }
    
    return null;
}

async function getAssetInfo(assetId) {
    try {
        // Check cache first
        const cachedData = await redis.get(`asset:${assetId}`);
        if (cachedData) {
            return JSON.parse(cachedData);
        }

        // Fetch both basic asset data and metadata from Blockfrost
        const [assetData, assetMetadata] = await Promise.all([
            fetchBlockfrost(`/assets/${assetId}`, 'fetch asset data'),
            fetchBlockfrost(`/assets/${assetId}/metadata`, 'fetch asset metadata')
        ]);
        
        // Process asset metadata
        const onchainMetadata = assetData.onchain_metadata || {};
        const metadata = assetMetadata || {};
        
        // Determine if NFT based on quantity
        const isNft = assetData.quantity === '1';
        
        // Get decimals (tokens only)
        let decimals = 0;
        if (!isNft) {
            try {
                decimals = parseInt(metadata.decimals || onchainMetadata.decimals) || 0;
                // Cap decimals at 8 to prevent issues
                decimals = Math.min(decimals, 8);
            } catch {
                decimals = 0;
            }
        }
        
        // Get asset name from metadata or onchain_metadata
        let name = null;
        if (isNft) {
            // For NFTs, try these fields in order
            name = onchainMetadata.name || 
                   onchainMetadata.display_name ||
                   assetData.display_name ||
                   metadata.name ||
                   assetData.asset_name;
        } else {
            // For tokens, try these fields in order
            name = metadata.name ||
                   metadata.display_name ||
                   assetData.display_name ||
                   onchainMetadata.name ||
                   onchainMetadata.display_name ||
                   assetData.asset_name;
        }

        // Get ticker if available
        const ticker = metadata.ticker || onchainMetadata.ticker || assetData.ticker;

        // If no name found, try to decode from hex
        if (!name && assetId) {
            try {
                // Split by '.' and take the last part
                const hexName = assetId.split('.').pop();
                // Check if it's a valid hex string
                if (hexName && /^[0-9a-fA-F]+$/.test(hexName)) {
                    const decoded = Buffer.from(hexName, 'hex').toString('utf8');
                    // Only use if all characters are printable ASCII
                    if (decoded && /^[\x20-\x7E]*$/.test(decoded)) {
                        name = decoded;
                    }
                }
            } catch (e) {
                console.error('Error decoding hex name:', e);
            }
        }

        // Fallback to asset ID if still no name
        if (!name) {
            name = assetId.slice(-8);
        }

        // Log what we found
        console.log('Asset data for', assetId, {
            name,
            ticker,
            metadata,
            onchainMetadata,
            assetData
        });

        // Get image URL from various sources with priority
        let imageUrl = null;
        const validUrls = [];
        
        // For tokens, check metadata fields
        if (metadata) {
            const tokenImageFields = ['logo', 'icon', 'image'];
            for (const field of tokenImageFields) {
                if (metadata[field]) {
                    const url = isValidUrl(metadata[field]);
                    if (url) {
                        validUrls.push(['metadata', field, url]);
                    }
                }
            }
        }
        
        // For NFTs, check onchain metadata
        if (onchainMetadata) {
            const nftImageFields = ['image', 'mediaUrl', 'thumbnailUrl'];
            for (const field of nftImageFields) {
                if (onchainMetadata[field]) {
                    const url = isValidUrl(onchainMetadata[field]);
                    if (url) {
                        validUrls.push(['onchain', field, url]);
                    }
                }
            }
        }
        
        // Check root level info
        const rootImageFields = ['logo', 'icon', 'image'];
        for (const field of rootImageFields) {
            if (assetData[field]) {
                const url = isValidUrl(assetData[field]);
                if (url) {
                    validUrls.push(['root', field, url]);
                }
            }
        }
        
        // Priority order matching the working code
        const priorityOrder = {
            'onchain.image': 1,
            'metadata.image': 2,
            'onchain.mediaUrl': 3,
            'metadata.logo': 4,
            'metadata.icon': 5,
            'root.image': 6,
            'root.logo': 7,
            'root.icon': 8
        };
        
        // Sort by priority and take the highest priority URL
        if (validUrls.length > 0) {
            validUrls.sort((a, b) => {
                const priorityA = priorityOrder[`${a[0]}.${a[1]}`] || 999;
                const priorityB = priorityOrder[`${b[0]}.${b[1]}`] || 999;
                return priorityA - priorityB;
            });
            imageUrl = validUrls[0][2];
        }
        
        const assetInfo = {
            unit: assetId,
            name: name || assetId.slice(-8),  // Ensure name is never null
            decimals,
            ticker,
            image: imageUrl,  // Can be null if no valid URL found
            is_nft: isNft  // Add NFT flag
        };

        // Cache it
        await redis.set(`asset:${assetId}`, JSON.stringify(assetInfo));
        return assetInfo;
    } catch (error) {
        console.error(`Error getting asset info for ${assetId}:`, error);
        return null;
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

// Helper to safely format token amounts
function formatAmount(quantity, decimals) {
    try {
        if (decimals === 0) return quantity;
        
        // Handle the amount as a string to avoid number precision issues
        const str = quantity.padStart(decimals + 1, '0');
        const whole = str.slice(0, -decimals) || '0';
        const fraction = str.slice(-decimals);
        
        return `${whole}.${fraction}`;
    } catch {
        return null;
    }
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!isValidCardanoAddress(address)) {
            return res.status(400).json({ error: 'Invalid Cardano address' });
        }

        // 1. Get address data from Blockfrost
        const addressData = await fetchBlockfrost(`/addresses/${address}`, 'fetch address data');
        
        // 2. Process assets and get their details
        const assets = [];
        for (const amount of addressData.amount) {
            try {
                if (amount.unit === 'lovelace') continue;

                // Get asset details from cache or Blockfrost
                const cacheKey = `asset:${amount.unit}`;
                let assetInfo = await getFromCache(cacheKey);
                
                if (!assetInfo) {
                    // Fetch from Blockfrost if not in cache
                    assetInfo = await fetchBlockfrost(`/assets/${amount.unit}`, 'fetch asset data');
                    // Cache forever since Cardano assets are immutable
                    await setInCache(cacheKey, assetInfo);
                }

                // Process metadata like the Discord bot
                const onchainMetadata = assetInfo.onchain_metadata || {};
                const metadata = assetInfo.metadata || {};

                // Get image URL
                let imageUrl = null;
                // For tokens, check metadata fields
                if (metadata) {
                    for (const field of ['logo', 'icon', 'image']) {
                        if (metadata[field]) {
                            const url = isValidUrl(metadata[field]);
                            if (url) {
                                imageUrl = url;
                                break;
                            }
                        }
                    }
                }
                // For NFTs, check onchain metadata
                if (!imageUrl && onchainMetadata) {
                    for (const field of ['image', 'mediaUrl', 'thumbnailUrl']) {
                        if (onchainMetadata[field]) {
                            const url = isValidUrl(onchainMetadata[field]);
                            if (url) {
                                imageUrl = url;
                                break;
                            }
                        }
                    }
                }

                // Get name from metadata or onchain_metadata
                const name = onchainMetadata.name || 
                            metadata.name || 
                            (() => {
                                try {
                                    const hexName = amount.unit.split('.').pop();
                                    if (hexName && /^[0-9a-fA-F]+$/.test(hexName)) {
                                        const decoded = Buffer.from(hexName, 'hex').toString('utf8');
                                        if (decoded && /^[\x20-\x7E]*$/.test(decoded)) return decoded;
                                    }
                                } catch {}
                                return amount.unit;
                            })();

                assets.push({
                    unit: amount.unit,
                    quantity: amount.quantity,
                    decimals: metadata.decimals || 0,
                    name: name,
                    image: imageUrl,
                    ticker: metadata.ticker || null,
                    is_nft: amount.quantity === '1'
                });
            } catch (error) {
                console.error(`Error processing asset ${amount.unit}:`, error);
            }
        }

        // 3. Send response
        res.json({
            address,
            stake_address: addressData.stake_address,
            balance: addressData.amount.find(a => a.unit === 'lovelace')?.quantity || '0',
            assets: assets
        });

    } catch (error) {
        console.error('Error in /api/wallet/:address:', error);
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
