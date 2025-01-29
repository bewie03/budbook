const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const fs = require('fs').promises;
const crypto = require('crypto');

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
            // Check cache first since token metadata never changes
            const assetData = await getAssetInfo(asset.unit);
            return {
              ...asset,
              ...assetData
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
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(error.message.includes('not found') ? 404 : 500).json({ 
      error: error.message,
      details: error.response ? await error.response.text() : null
    });
  }
});

// Payment verification
const MIN_PAYMENT = 2;
const MAX_PAYMENT = 3;
const pendingPayments = new Map(); // Store pending payments with their exact amounts

app.post('/api/request-payment', async (req, res) => {
  try {
    // Generate random amount between MIN_PAYMENT and MAX_PAYMENT
    const exactAmount = (Math.random() * (MAX_PAYMENT - MIN_PAYMENT) + MIN_PAYMENT).toFixed(2);
    const paymentId = crypto.randomBytes(16).toString('hex');
    
    // Store the payment request with timestamp
    pendingPayments.set(paymentId, {
      amount: exactAmount,
      timestamp: Date.now(),
      verified: false
    });

    // Clean up old pending payments (older than 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [id, payment] of pendingPayments) {
      if (payment.timestamp < oneHourAgo) {
        pendingPayments.delete(id);
      }
    }

    res.json({
      paymentId,
      amount: exactAmount,
      address: PAYMENT_ADDRESS
    });
  } catch (error) {
    console.error('Error generating payment request:', error);
    res.status(500).json({ error: 'Failed to generate payment request' });
  }
});

app.get('/api/verify-payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const payment = pendingPayments.get(paymentId);

    if (!payment) {
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    if (payment.verified) {
      return res.json({ verified: true });
    }

    // Get recent transactions
    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`, {
      headers: { 'project_id': BLOCKFROST_API_KEY }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch transactions');
    }

    const transactions = await response.json();

    // Check recent transactions for the exact amount
    for (const tx of transactions) {
      const txResponse = await fetch(`${BLOCKFROST_BASE_URL}/txs/${tx.tx_hash}/utxos`, {
        headers: { 'project_id': BLOCKFROST_API_KEY }
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
      if (amountReceived === parseFloat(payment.amount)) {
        payment.verified = true;
        pendingPayments.set(paymentId, payment);
        console.log('Payment verified for ID:', paymentId);
        break;
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

    // Check pending payments for matching amount
    for (const [paymentId, payment] of pendingPayments) {
      if (Math.abs(parseFloat(payment.amount) - amountAda) < 0.000001) { // Account for floating point precision
        payment.verified = true;
        pendingPayments.set(paymentId, payment);
        console.log('Payment verified for ID:', paymentId);
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
