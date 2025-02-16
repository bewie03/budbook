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
const BONE_POLICY_ID = process.env.BONE_POLICY_ID;
const BONE_ASSET_NAME = process.env.BONE_ASSET_NAME;
const REQUIRED_BONE_PAYMENT = parseInt(process.env.REQUIRED_BONE_PAYMENT || 1);

// Initialize cache with 1 hour TTL
const cache = new NodeCache({ stdTTL: 3600 });

// Helper functions for Cache
function getFromCache(key) {
    return cache.get(key);
}

function setInCache(key, value, ttl = 3600) {
    return cache.set(key, value, ttl);
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
        console.log('Fetching wallet data for address:', address);
        
        if (!isValidCardanoAddress(address)) {
            console.error('Invalid address format:', address);
            return res.status(400).json({ error: 'Invalid Cardano address' });
        }

        // 1. Get address data from Blockfrost
        console.log('Fetching address data from Blockfrost...');
        const addressData = await fetchBlockfrost(`/addresses/${address}`, 'fetch address data');
        console.log('Address data received:', addressData);
        
        // Process assets and get their details
        const assets = [];
        console.log('Processing assets:', addressData.amount.length);
        
        for (const amount of addressData.amount) {
            try {
                if (amount.unit === 'lovelace') {
                    console.log('Skipping lovelace entry');
                    continue;
                }

                console.log('Processing asset:', amount.unit);
                
                // Get asset details from cache or Blockfrost
                const cacheKey = `asset:${amount.unit}`;
                let assetInfo = await getFromCache(cacheKey);
                
                if (!assetInfo) {
                    console.log('Cache miss for asset:', amount.unit);
                    // Fetch from Blockfrost if not in cache
                    assetInfo = await fetchBlockfrost(`/assets/${amount.unit}`, 'fetch asset data');
                    console.log('Asset info from Blockfrost:', assetInfo);
                    // Cache forever since Cardano assets are immutable
                    await setInCache(cacheKey, assetInfo);
                } else {
                    console.log('Cache hit for asset:', amount.unit);
                }

                // Process metadata like the Discord bot
                const onchainMetadata = assetInfo.onchain_metadata || {};
                const metadata = assetInfo.metadata || {};

                // Get image URL
                let imageUrl = null;
                // Check both metadata and onchain_metadata for image
                const possibleImageFields = ['logo', 'icon', 'image', 'mediaType', 'image1'];
                
                // First check onchain_metadata
                for (const field of possibleImageFields) {
                    if (onchainMetadata[field]) {
                        const url = isValidUrl(onchainMetadata[field]);
                        if (url) {
                            imageUrl = url;
                            break;
                        }
                    }
                }
                
                // If no image found in onchain_metadata, check metadata
                if (!imageUrl) {
                    for (const field of possibleImageFields) {
                        if (metadata[field]) {
                            const url = isValidUrl(metadata[field]);
                            if (url) {
                                imageUrl = url;
                                break;
                            }
                        }
                    }
                }

                // Structure the asset data
                const asset = {
                    unit: amount.unit,
                    quantity: amount.quantity,
                    decimals: assetInfo.decimals || 0,
                    name: metadata.name || onchainMetadata.name || assetInfo.asset_name || amount.unit,
                    ticker: metadata.ticker || onchainMetadata.ticker || null,
                    description: metadata.description || onchainMetadata.description || null,
                    image: imageUrl,
                    fingerprint: assetInfo.fingerprint,
                    metadata: metadata,
                    onchainMetadata: onchainMetadata,
                    is_nft: amount.quantity === '1' || onchainMetadata?.type === 'NFT'
                };

                console.log('Processed asset:', {
                    unit: asset.unit,
                    name: asset.name,
                    quantity: asset.quantity,
                    decimals: asset.decimals,
                    is_nft: asset.is_nft
                });

                assets.push(asset);
            } catch (error) {
                console.error(`Error processing asset ${amount.unit}:`, error);
                // Add minimal asset data if processing fails
                assets.push({
                    unit: amount.unit,
                    quantity: amount.quantity,
                    name: amount.unit.slice(-amount.unit.length + 56), // Get asset name from unit
                    decimals: 0,
                    is_nft: amount.quantity === '1'
                });
            }
        }

        const response = {
            address: addressData.address,
            stake_address: addressData.stake_address,
            type: addressData.type,
            balance: addressData.amount.find(a => a.unit === 'lovelace')?.quantity || '0',
            assets: assets
        };

        console.log('Sending response with assets count:', assets.length);
        return res.json(response);

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
    
    // Cache for 15 minutes
    await setInCache(`payment:${paymentId}`, payment, 900);
    await setInCache(`install_payment:${installId}`, paymentId, 900);
    
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

// Payment verification function
async function verifyPayment(txHash, installId) {
    try {
        // Get transaction details
        const txData = await fetchBlockfrost(`/txs/${txHash}/utxos`, 'fetch transaction UTXOs');
        if (!txData || !txData.outputs) {
            console.log('No transaction data found');
            return false;
        }

        // Find output to our payment address
        const paymentOutput = txData.outputs.find(output => 
            output.address === PAYMENT_ADDRESS
        );

        if (!paymentOutput) {
            console.log('No payment to our address found');
            return false;
        }

        // Check for BONE token payment
        const boneAsset = paymentOutput.amount.find(asset => 
            asset.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`
        );

        if (!boneAsset) {
            console.log('No BONE token payment found');
            return false;
        }

        const boneAmount = parseInt(boneAsset.quantity);
        console.log('BONE payment received:', boneAmount, 'BONE');

        if (boneAmount < REQUIRED_BONE_PAYMENT) {
            console.log('Insufficient BONE payment');
            return false;
        }

        // Get all payment keys from cache
        const keys = await cache.keys('payment:*');
        console.log('Found payment keys:', keys);
        
        // Check each payment for matching tx hash
        for (const key of keys) {
            const payment = await getFromCache(key);
            if (payment && payment.txHash === txHash) {
                console.log('Payment already processed');
                return false;
            }
        }

        // Create new payment record
        const paymentId = crypto.randomBytes(16).toString('hex');
        const payment = {
            id: paymentId,
            txHash,
            installId,
            amount: boneAmount,
            timestamp: Date.now(),
            used: false
        };

        // Store payment
        await setInCache(`payment:${paymentId}`, payment, 24 * 60 * 60); // 24 hour TTL
        await setInCache(`install_payment:${installId}`, paymentId, 24 * 60 * 60);

        return true;
    } catch (error) {
        console.error('Error verifying payment:', error);
        return false;
    }
}

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
      await cache.del(`install_payment:${payment.installId}`);
      return res.json({ verified: true, used: false });
    }

    // If not verified, check blockchain
    try {
      const txs = await fetchBlockfrost(`/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`);
      console.log('Recent transactions:', JSON.stringify(txs, null, 2));

      // Check last 10 transactions
      for (const tx of txs.slice(0, 10)) {
        const txDetails = await fetchBlockfrost(`/txs/${tx.tx_hash}/utxos`);
        console.log('Transaction details:', JSON.stringify(txDetails, null, 2));

        // Find output to our address
        const output = txDetails.outputs.find(o => 
          o.address === PAYMENT_ADDRESS && 
          o.amount.some(a => a.unit === 'lovelace')
        );

        if (output) {
          const amountAda = parseInt(output.amount.find(a => a.unit === 'lovelace').quantity) / 1000000;
          console.log('Found payment:', amountAda, 'ADA');

          if (amountAda >= parseFloat(payment.amount)) {
            payment.verified = true;
            await setInCache(`payment:${paymentId}`, payment);
            console.log('Payment verified through blockchain check');
            return res.json({ verified: true, used: false });
          }
        }
      }
    } catch (error) {
      console.error('Error checking blockchain:', error);
    }

    // Not verified
    return res.json({ verified: false });

  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Payment verification SSE endpoint
app.get('/api/payment-updates/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  
  // Check if payment exists first
  const payment = await getFromCache(`payment:${paymentId}`);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found or expired' });
  }
  
  // Set headers for SSE with CORS
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  // Send initial status
  res.write(`data: ${JSON.stringify({ verified: payment.verified, used: payment.used })}\n\n`);
  // Send heartbeat immediately
  res.write(':\n\n');

  // Create unique client ID
  const clientId = Date.now();

  // Store the response object for this client
  if (!global.clients) global.clients = new Map();
  global.clients.set(clientId, { res, paymentId });

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(':\n\n');
    } catch (error) {
      console.error('Error sending heartbeat:', error);
      clearInterval(heartbeat);
      global.clients.delete(clientId);
    }
  }, 30000);

  // Remove client and clear heartbeat on connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    global.clients.delete(clientId);
  });

  // Handle errors
  req.on('error', (error) => {
    console.error('SSE connection error:', error);
    clearInterval(heartbeat);
    global.clients.delete(clientId);
  });
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
    console.log('Received webhook payload:', JSON.stringify(payload, null, 2));

    // Extract transaction details
    const tx = payload.payload;
    if (!tx || !tx.outputs) {
      console.error('Invalid webhook payload - missing tx or outputs');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Find the output to our payment address with BONE tokens
    const paymentOutput = tx.outputs.find(output => 
      output.address === PAYMENT_ADDRESS && 
      output.amount && 
      output.amount.length > 0 &&
      output.amount.some(asset => asset.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`)
    );

    if (!paymentOutput) {
      console.error('No valid BONE payment to verification address found');
      console.log('Available outputs:', JSON.stringify(tx.outputs, null, 2));
      return res.status(400).json({ error: 'No relevant payment found' });
    }

    // Get BONE token amount
    const boneAsset = paymentOutput.amount.find(asset => 
      asset.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`
    );
    const boneAmount = parseInt(boneAsset.quantity);
    console.log('BONE payment received:', boneAmount, 'BONE');

    // Get all payment keys from cache
    const keys = await cache.keys('payment:*');
    console.log('Found payment keys:', keys);
    
    // Check each payment for matching transaction
    let verifiedPayment = false;
    for (const key of keys) {
      const payment = await getFromCache(key);
      console.log('Checking payment:', key, payment);
      
      if (payment && !payment.verified) {
        // Verify if received amount is at least 100 BONE
        if (boneAmount >= REQUIRED_BONE_PAYMENT) {
          payment.verified = true;
          payment.txHash = tx.hash;
          await setInCache(key, payment);
          const paymentId = key.split(':')[1];
          console.log('Payment verified for ID:', paymentId);
          verifiedPayment = true;
          
          // Notify all clients watching this payment
          if (global.clients) {
            for (const [clientId, client] of global.clients) {
              if (client.paymentId === paymentId) {
                try {
                  client.res.write(`data: ${JSON.stringify({ verified: true, used: false })}\n\n`);
                  console.log('Notified client:', clientId);
                } catch (error) {
                  console.error('Error notifying client:', error);
                }
              }
            }
          }
          break;
        }
      }
    }

    if (!verifiedPayment) {
      console.log('No pending payment requests found for this transaction');
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual payment verification endpoint
app.get('/api/verify-payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    console.log('Manual verification request for payment:', paymentId);
    
    const payment = await getFromCache(`payment:${paymentId}`);

    if (!payment) {
      console.log('Payment not found or expired');
      return res.status(404).json({ error: 'Payment request not found or expired' });
    }

    if (payment.verified) {
      console.log('Payment already verified');
      if (payment.used) {
        return res.json({ verified: true, used: true });
      }
      // Mark payment as used
      payment.used = true;
      await setInCache(`payment:${paymentId}`, payment);
      // Remove the installation ID payment reference
      await cache.del(`install_payment:${payment.installId}`);
      return res.json({ verified: true, used: false });
    }

    // If not verified, check blockchain
    try {
      const txs = await fetchBlockfrost(`/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`);
      console.log('Recent transactions:', JSON.stringify(txs, null, 2));

      // Check last 10 transactions
      for (const tx of txs.slice(0, 10)) {
        const txDetails = await fetchBlockfrost(`/txs/${tx.tx_hash}/utxos`);
        console.log('Transaction details:', JSON.stringify(txDetails, null, 2));

        // Find output to our address
        const output = txDetails.outputs.find(o => 
          o.address === PAYMENT_ADDRESS && 
          o.amount.some(a => a.unit === 'lovelace')
        );

        if (output) {
          const amountAda = parseInt(output.amount.find(a => a.unit === 'lovelace').quantity) / 1000000;
          console.log('Found payment:', amountAda, 'ADA');

          if (amountAda >= parseFloat(payment.amount)) {
            payment.verified = true;
            await setInCache(`payment:${paymentId}`, payment);
            console.log('Payment verified through blockchain check');
            return res.json({ verified: true, used: false });
          }
        }
      }
    } catch (error) {
      console.error('Error checking blockchain:', error);
    }

    // Not verified
    return res.json({ verified: false });

  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Debug endpoint to check recent transactions
app.get('/api/debug/recent-transactions', async (req, res) => {
  try {
    console.log('Checking recent transactions...');
    const txs = await fetchBlockfrost(`/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`);
    console.log('Recent transactions:', JSON.stringify(txs, null, 2));

    const transactions = [];
    
    // Check last 10 transactions
    for (const tx of txs.slice(0, 10)) {
      const txDetails = await fetchBlockfrost(`/txs/${tx.tx_hash}/utxos`);
      console.log('Transaction details:', JSON.stringify(txDetails, null, 2));

      // Find output to our address
      const output = txDetails.outputs.find(o => 
        o.address === PAYMENT_ADDRESS && 
        o.amount.some(a => a.unit === 'lovelace')
      );

      if (output) {
        const amountAda = parseInt(output.amount.find(a => a.unit === 'lovelace').quantity) / 1000000;
        transactions.push({
          tx_hash: tx.tx_hash,
          amount: amountAda,
          block_time: tx.block_time
        });
      }
    }

    res.json({
      address: PAYMENT_ADDRESS,
      transactions
    });
  } catch (error) {
    console.error('Error checking transactions:', error);
    res.status(500).json({ error: 'Failed to check transactions' });
  }
});

// Add endpoint to view cache
app.get('/api/cache', async (req, res) => {
  try {
    // Get all keys from cache
    const keys = await cache.keys('*');
    const cacheData = {};

    // Get data for each key
    for (const key of keys) {
      const value = await getFromCache(key);
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

// Clear cache
app.post('/api/clear-cache', async (req, res) => {
  try {
    await cache.flushAll();
    console.log('Cache cleared');
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Get account info
app.get('/api/accounts/:stake_address', async (req, res) => {
  try {
    const { stake_address } = req.params;
    console.log('Fetching account info for stake address:', stake_address);

    // Check cache first
    const cacheKey = `account_${stake_address}`;
    const cachedData = await getFromCache(cacheKey);
    if (cachedData) {
      console.log('Returning cached account data');
      return res.json(cachedData);
    }

    const accountData = await fetchBlockfrost(`/accounts/${stake_address}`, 'Failed to fetch account data');
    
    // If account is delegated, fetch pool info
    if (accountData.pool_id) {
      const poolData = await fetchBlockfrost(`/pools/${accountData.pool_id}`, 'Failed to fetch pool data');
      accountData.pool_info = poolData;
    }
    
    // Cache the data for 5 minutes
    await setInCache(cacheKey, accountData, 300);
    
    res.json(accountData);
  } catch (error) {
    console.error('Error in /api/accounts/:stake_address:', error);
    res.status(500).json({ error: 'Failed to fetch account data' });
  }
});

// Get account rewards
app.get('/api/accounts/:stake_address/rewards', async (req, res) => {
  try {
    const { stake_address } = req.params;
    console.log('Fetching rewards for stake address:', stake_address);

    // Check cache first
    const cacheKey = `rewards_${stake_address}`;
    const cachedData = await getFromCache(cacheKey);
    if (cachedData) {
      console.log('Returning cached rewards data');
      return res.json(cachedData);
    }

    const rewardsData = await fetchBlockfrost(`/accounts/${stake_address}/rewards`, 'Failed to fetch rewards data');
    
    // Cache the data for 5 minutes
    await setInCache(cacheKey, rewardsData, 300);
    
    res.json(rewardsData);
  } catch (error) {
    console.error('Error in /api/accounts/:stake_address/rewards:', error);
    res.status(500).json({ error: 'Failed to fetch rewards data' });
  }
});

// Get account/staking info
app.get('/api/accounts/:stakeAddress', async (req, res) => {
  try {
    const { stakeAddress } = req.params;
    console.log('Fetching account info for stake address:', stakeAddress);

    // Get account info from Blockfrost
    const accountInfo = await fetchBlockfrost(`/accounts/${stakeAddress}`, 'fetch account info');
    console.log('Account info received:', accountInfo);

    // Get pool info if the account is delegating
    let poolInfo = null;
    if (accountInfo.pool_id) {
      console.log('Fetching pool info for:', accountInfo.pool_id);
      poolInfo = await fetchBlockfrost(`/pools/${accountInfo.pool_id}`, 'fetch pool info');
      console.log('Pool info received:', poolInfo);
    }

    // Format response
    const response = {
      ...accountInfo,
      pool_info: poolInfo,
      active: !!accountInfo.pool_id
    };

    res.json(response);
  } catch (error) {
    console.error('Error in /api/accounts/:stakeAddress:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

// Get account rewards
app.get('/api/accounts/:stakeAddress/rewards', async (req, res) => {
  try {
    const { stakeAddress } = req.params;
    console.log('Fetching rewards for stake address:', stakeAddress);

    // Get rewards history from Blockfrost
    const rewards = await fetchBlockfrost(`/accounts/${stakeAddress}/rewards`, 'fetch rewards');
    console.log('Rewards received:', rewards);

    res.json(rewards);
  } catch (error) {
    console.error('Error in /api/accounts/:stakeAddress/rewards:', error);
    res.status(500).json({ error: 'Failed to fetch rewards' });
  }
});

// Get pool information
app.get('/api/pools/:poolId', async (req, res) => {
  try {
    const { poolId } = req.params;
    console.log('Fetching pool info for:', poolId);

    // Get pool info from Blockfrost
    const poolInfo = await fetchBlockfrost(`/pools/${poolId}`, 'fetch pool info');
    console.log('Pool info received:', poolInfo);

    // Get pool metadata if available
    let metadata = null;
    if (poolInfo.metadata_url) {
      try {
        const metadataResponse = await fetch(poolInfo.metadata_url);
        metadata = await metadataResponse.json();
        console.log('Pool metadata received:', metadata);
      } catch (metadataError) {
        console.error('Error fetching pool metadata:', metadataError);
      }
    }

    // Format response
    const response = {
      ...poolInfo,
      metadata
    };

    res.json(response);
  } catch (error) {
    console.error('Error in /api/pools/:poolId:', error);
    res.status(500).json({ error: 'Failed to fetch pool info' });
  }
});

// Get account/staking info
app.get('/api/accounts/:stakeAddress', async (req, res) => {
  try {
    const { stakeAddress } = req.params;
    console.log('Fetching account info for stake address:', stakeAddress);

    // Get account info from Blockfrost
    const accountInfo = await fetchBlockfrost(`/accounts/${stakeAddress}`, 'fetch account info');
    console.log('Account info received:', accountInfo);

    // Get pool ticker if staked
    let ticker = 'Unstaked';
    if (accountInfo.pool_id) {
      try {
        const poolInfo = await fetchBlockfrost(`/pools/${accountInfo.pool_id}`, 'fetch pool info');
        console.log('Pool info received:', poolInfo);
        
        // Get pool metadata
        if (poolInfo.metadata_hash) {
          const poolMetadata = await fetchBlockfrost(`/pools/${accountInfo.pool_id}/metadata`, 'fetch pool metadata');
          ticker = poolMetadata?.ticker || 'Unknown Pool';
          console.log('Pool metadata received:', poolMetadata);
        }
      } catch (poolError) {
        console.error('Error fetching pool info:', poolError);
        ticker = 'Unknown Pool';
      }
    }

    // Get total rewards (convert from Lovelace to ADA)
    let totalRewards = '0';
    try {
      const rewards = await fetchBlockfrost(`/accounts/${stakeAddress}/rewards`, 'fetch rewards');
      // Get the latest reward
      const latestReward = rewards[0]?.amount || '0';
      // Convert from Lovelace to ADA (1 ADA = 1,000,000 Lovelace)
      totalRewards = (parseInt(latestReward) / 1000000).toString();
      console.log('Latest reward (ADA):', totalRewards);
    } catch (rewardsError) {
      console.error('Error fetching rewards:', rewardsError);
    }

    // Format response
    const response = {
      stake_address: stakeAddress,
      ticker,
      rewards: totalRewards,
      active: !!accountInfo.pool_id
    };

    console.log('Sending response:', response);
    res.json(response);
  } catch (error) {
    console.error('Error in /api/accounts/:stakeAddress:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
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
