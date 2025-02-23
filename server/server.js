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
const REQUIRED_BONE_PAYMENT = parseInt(process.env.REQUIRED_BONE_PAYMENT || 1);
const BLOCKFROST_WEBHOOK_ID = process.env.BLOCKFROST_WEBHOOK_ID;
const BLOCKFROST_WEBHOOK_TOKEN = process.env.BLOCKFROST_WEBHOOK_TOKEN;
const BONE_POLICY_ID = process.env.BONE_POLICY_ID;
const BONE_ASSET_NAME = process.env.BONE_ASSET_NAME;

// Initialize cache with 1 hour TTL
const cache = new NodeCache({ stdTTL: 3600 });

// Helper functions for Cache
function getFromCache(key) {
    const value = cache.get(key);
    console.log('Getting from cache:', { key, value });
    return value;
}

function setInCache(key, value, ttl = 3600) {
    console.log('Setting in cache:', { key, value });
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
  allowedHeaders: ['Content-Type', 'Blockfrost-Signature', 'Origin', 'Accept']
}));

app.use(express.json());

// Test webhook endpoint
app.post('/test-webhook', express.json(), (req, res) => {
  console.log('📝 Test webhook received:', {
    headers: req.headers,
    body: JSON.stringify(req.body, null, 2)
  });
  res.status(200).json({ status: 'ok', received: true });
});

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
app.get('/health', async (req, res) => {
  try {
    // Check Blockfrost connection
    const response = await fetch(`${BLOCKFROST_BASE_URL}/blocks/latest`, {
      headers: { 
        'project_id': BLOCKFROST_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Blockfrost connection failed');
    }

    res.status(200).json({ 
      status: 'ok',
      blockfrost: 'connected',
      webhook: {
        id: BLOCKFROST_WEBHOOK_ID,
        configured: true
      }
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'error',
      error: error.message
    });
  }
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
  // Basic validation - let Blockfrost API handle detailed validation
  if (!address || typeof address !== 'string') return false;
  
  // Just check if it starts with a valid prefix
  const validPrefixes = ['addr1', 'Ae2', 'DdzFF', 'stake1'];
  const hasValidPrefix = validPrefixes.some(prefix => address.startsWith(prefix));
  
  // Minimum length check (reasonable minimum for any Cardano address)
  const hasValidLength = address.length >= 50;

  return hasValidPrefix && hasValidLength;
}

// Helper to safely format token amounts
function formatAmount(quantity, decimals) {
  try {
    console.log('Formatting amount:', { quantity, decimals });
    
    // Ensure decimals is a number
    decimals = Number(decimals);
    if (isNaN(decimals)) {
      console.log('Invalid decimals, defaulting to 0');
      decimals = 0;
    }

    // For NFTs just return 1
    if (quantity === '1' && decimals === 0) {
      return '1';
    }

    // Convert to BigInt and divide by 10^decimals
    const rawAmount = BigInt(quantity);
    const divisor = BigInt(10 ** decimals);
    const wholePart = rawAmount / divisor;
    const fractionalPart = rawAmount % divisor;
    
    // Format whole part with commas
    let result = wholePart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    
    // Add fractional part if exists
    if (fractionalPart > 0) {
      // Pad with leading zeros if needed
      let fractionalStr = fractionalPart.toString().padStart(decimals, '0');
      // Remove trailing zeros
      fractionalStr = fractionalStr.replace(/0+$/, '');
      if (fractionalStr.length > 0) {
        result += '.' + fractionalStr;
      }
    }
    
    console.log('Formatted result:', {
      input: { quantity, decimals },
      calculations: {
        rawAmount: rawAmount.toString(),
        divisor: divisor.toString(),
        wholePart: wholePart.toString(),
        fractionalPart: fractionalPart.toString()
      },
      result
    });
    return result;
  } catch (error) {
    console.error('Error formatting amount:', error);
    return quantity.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

// Helper function to validate URLs
function isValidUrl(url) {
  try {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    if (!url) return false;
    
    // Handle special cases for IPFS
    if (url.startsWith('ipfs://')) return true;
    if (url.includes('/ipfs/')) return true;
    
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const forceRefresh = req.query.forceRefresh === 'true';
        console.log('Fetching wallet data for address:', address, 'Force refresh:', forceRefresh);
        
        if (!isValidCardanoAddress(address)) {
            console.error('Invalid address format:', address);
            return res.status(400).json({ error: 'Invalid Cardano address' });
        }

        // Clear asset caches if force refresh
        if (forceRefresh) {
            const cacheKeys = await cache.keys(`asset_${address}_*`);
            if (cacheKeys.length > 0) {
                await Promise.all(cacheKeys.map(key => cache.del(key)));
                console.log('Cleared asset caches:', cacheKeys.length);
            }
        }

        // 1. Get address data from Blockfrost
        console.log('Fetching address data from Blockfrost...');
        const addressData = await fetchBlockfrost(`/addresses/${address}`, 'fetch address data');
        console.log('Address data received:', addressData);
        
        // Process assets and get their details
        const assets = [];
        console.log('Processing assets:', addressData.amount.length);
        
        // Sort assets by quantity (value) before processing
        const sortedAmounts = addressData.amount
            .filter(a => a.unit !== 'lovelace')
            .sort((a, b) => {
                // Convert to BigInt for comparison
                const aQuantity = BigInt(a.quantity);
                const bQuantity = BigInt(b.quantity);
                // Return -1, 0, or 1 for sorting
                if (aQuantity < bQuantity) return 1;
                if (aQuantity > bQuantity) return -1;
                return 0;
            });
        
        // Process top 250 assets
        const assetsToProcess = sortedAmounts.slice(0,250);
        console.log('Processing top 250 assets out of:', sortedAmounts.length);
        
        for (const amount of assetsToProcess) {
            try {
                console.log('Processing asset:', amount.unit);
                
                // Get asset details from Blockfrost
                const cacheKey = `asset_${address}_${amount.unit}`;
                let assetInfo = forceRefresh ? null : await getFromCache(cacheKey);
                
                if (!assetInfo) {
                    console.log('Cache miss for asset:', amount.unit);
                    // Fetch from Blockfrost if not in cache
                    assetInfo = await fetchBlockfrost(`/assets/${amount.unit}`, 'fetch asset data');
                    console.log('Raw Blockfrost response:', JSON.stringify(assetInfo, null, 2));
                    // Cache forever since Cardano assets are immutable
                    await setInCache(cacheKey, assetInfo);
                } else {
                    console.log('Cache hit for asset:', amount.unit);
                    console.log('Cached asset info:', JSON.stringify(assetInfo, null, 2));
                }

                // Process metadata like the Discord bot
                const onchainMetadata = assetInfo.onchain_metadata || {};
                const metadata = assetInfo.metadata || {};
                
                // Get decimals directly from Blockfrost response
                let decimals = assetInfo.decimals;
                if (decimals === undefined || decimals === null) {
                    console.log('No decimals in asset info, checking metadata');
                    decimals = metadata.decimals || onchainMetadata.decimals;
                }
                console.log('Using decimals:', decimals);

                // Get image URL
                let imageUrl = null;
                // Check both metadata and onchain_metadata for image
                const possibleImageFields = ['logo', 'icon', 'image', 'mediaType', 'image1'];
                
                // First check onchain_metadata
                for (const field of possibleImageFields) {
                    if (onchainMetadata[field] && isValidUrl(onchainMetadata[field])) {
                        imageUrl = onchainMetadata[field];
                        break;
                    }
                }
                
                // If no image found in onchain_metadata, check metadata
                if (!imageUrl) {
                    for (const field of possibleImageFields) {
                        if (metadata[field] && isValidUrl(metadata[field])) {
                            imageUrl = metadata[field];
                            break;
                        }
                    }
                }

                console.log('Pre-formatting quantity:', {
                    raw: amount.quantity,
                    decimals: decimals,
                    metadata: metadata.decimals,
                    onchainMetadata: onchainMetadata.decimals
                });

                // Structure the asset data
                const asset = {
                    unit: amount.unit,
                    quantity: formatAmount(amount.quantity, decimals),
                    name: metadata.name || onchainMetadata.name || assetInfo.asset_name || amount.unit,
                    ticker: metadata.ticker || onchainMetadata.ticker || null,
                    description: metadata.description || onchainMetadata.description || null,
                    image: imageUrl,
                    fingerprint: assetInfo.fingerprint,
                    metadata: metadata,
                    onchainMetadata: onchainMetadata,
                    is_nft: amount.quantity === '1' || onchainMetadata?.type === 'NFT'
                };

                console.log('Final asset data:', {
                    unit: asset.unit,
                    name: asset.name,
                    quantity: asset.quantity,
                    decimals: decimals,
                    is_nft: asset.is_nft
                });

                assets.push(asset);
            } catch (error) {
                console.error(`Error processing asset ${amount.unit}:`, error);
                // Add minimal asset data if processing fails
                assets.push({
                    unit: amount.unit,
                    quantity: formatAmount(amount.quantity, 0), // Format quantity even in error case
                    name: amount.unit.slice(-amount.unit.length + 56), // Get asset name from unit
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

        console.log('Stake address:', response.stake_address);
        console.log('Sending response with assets count:', assets.length);
        return res.json(response);

    } catch (error) {
        console.error('Error in /api/wallet/:address:', error);
        res.status(500).json({ error: 'Failed to fetch wallet data' });
    }
});

// Helper function to get user slots
async function getUserSlots(userId) {
  try {
    const slots = await getFromCache(`slots:${userId}`);
    return slots || MAX_FREE_SLOTS;
  } catch (error) {
    console.error('Error getting user slots:', error);
    return MAX_FREE_SLOTS;
  }
}

// Helper function to update user slots
async function updateUserSlots(userId, additionalSlots) {
  try {
    const currentSlots = await getUserSlots(userId);
    const newSlots = Math.min(currentSlots + additionalSlots, MAX_TOTAL_SLOTS);
    await setInCache(`slots:${userId}`, newSlots);
    return newSlots;
  } catch (error) {
    console.error('Error updating user slots:', error);
    throw error;
  }
}

// Payment initiation endpoint
app.post('/api/initiate-payment', express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    // Check if user already has a pending payment
    const existingPaymentId = await getFromCache(`user_payment:${userId}`);
    if (existingPaymentId) {
      const existingPayment = await getFromCache(`payment:${existingPaymentId}`);
      if (existingPayment && !existingPayment.verified && (Date.now() - existingPayment.timestamp) < 900000) {
        // Return existing payment if it's less than 15 minutes old
        return res.json({
          paymentId: existingPaymentId,
          address: PAYMENT_ADDRESS,
          adaAmount: (existingPayment.adaAmount / 1000000).toFixed(6),
          boneAmount: existingPayment.boneAmount
        });
      }
    }

    // Generate random ADA amount between 1.9 and 2.1 ADA
    const adaAmount = (Math.random() * (2.1 - 1.9) + 1.9).toFixed(6);
    const lovelaceAmount = Math.floor(parseFloat(adaAmount) * 1000000); // Convert to lovelace
    
    // Generate payment ID
    const paymentId = crypto.randomBytes(16).toString('hex');
    
    // Store payment details with user ID
    const payment = {
      userId,
      boneAmount: REQUIRED_BONE_PAYMENT,
      adaAmount: lovelaceAmount,
      timestamp: Date.now(),
      verified: false
    };
    
    // Cache payment details for 15 minutes
    await setInCache(`payment:${paymentId}`, payment, 900);
    await setInCache(`user_payment:${userId}`, paymentId, 900);
    
    console.log('Payment initiated:', {
      ...payment,
      adaAmount: adaAmount // Log human-readable ADA amount
    });
    
    res.json({
      paymentId,
      address: PAYMENT_ADDRESS,
      adaAmount: adaAmount,
      boneAmount: REQUIRED_BONE_PAYMENT
    });

  } catch (error) {
    console.error('Error initiating payment:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// Payment verification function
async function verifyPayment(txHash, userId) {
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

        // Get payment details from cache
        const paymentId = await getFromCache(`user_payment:${userId}`);
        if (!paymentId) {
            console.log('No payment ID found for user ID');
            return false;
        }

        const payment = await getFromCache(`payment:${paymentId}`);
        if (!payment) {
            console.log('No payment details found');
            return false;
        }

        // Check ADA amount matches exactly
        const adaReceived = parseInt(paymentOutput.amount[0].quantity);
        if (adaReceived !== payment.adaAmount) {
            console.log('ADA amount mismatch:', { expected: payment.adaAmount, received: adaReceived });
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

        if (boneAmount < payment.boneAmount) {
            console.log('Insufficient BONE payment');
            return false;
        }

        // Get all payment keys from cache
        const keys = await cache.keys('payment:*');
        console.log('Found payment keys:', keys);
        
        // Check each payment for matching tx hash
        for (const key of keys) {
            const existingPayment = await getFromCache(key);
            if (existingPayment && existingPayment.txHash === txHash) {
                console.log('Payment already processed');
                return false;
            }
        }

        // Update payment record with tx hash
        payment.txHash = txHash;
        payment.verified = true;
        await setInCache(`payment:${paymentId}`, payment, 24 * 60 * 60); // 24 hour TTL

        return true;
    } catch (error) {
        console.error('Error verifying payment:', error);
        return false;
    }
}

// Get user slots endpoint
app.get('/api/slots/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const slots = await getUserSlots(userId);
    res.json({ slots });
  } catch (error) {
    console.error('Error getting slots:', error);
    res.status(500).json({ error: 'Failed to get slots' });
  }
});

// Payment verification endpoint - supports both payment IDs and tx hashes
app.get('/api/verify-payment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('Verification request for:', id);
    
    // First try to find by payment ID
    const payment = await getFromCache(`payment:${id}`);
    
    if (payment) {
      if (payment.verified) {
        const slots = await getUserSlots(payment.userId);
        return res.json({ 
          verified: true,
          slots,
          txHash: payment.txHash
        });
      }
      
      // If not verified but has txHash, verify it
      if (payment.txHash) {
        const verified = await verifyPayment(payment.txHash, payment.userId);
        if (verified) {
          const slots = await getUserSlots(payment.userId);
          return res.json({ 
            verified: true,
            slots,
            txHash: payment.txHash
          });
        }
      }
      
      return res.json({ verified: false });
    }
    
    // If no payment found, try to verify the ID as a transaction hash
    if (id.length === 64) { // Transaction hashes are 64 characters
      const verified = await verifyPayment(id);
      if (verified) {
        return res.json({ 
          verified: true,
          txHash: id
        });
      }
    }
    
    return res.status(404).json({ error: 'Payment not found' });
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

// Function to verify Blockfrost webhook signaturee
function verifyBlockfrostSignature(signatureHeader, payload, webhookToken) {
  try {
    if (!signatureHeader) {
      console.error('No Blockfrost-Signature header');
      return false;
    }

    // Parse the header
    const elements = signatureHeader.split(',');
    let timestamp = null;
    const signatures = [];

    for (const element of elements) {
      const [key, value] = element.split('=');
      if (key === 't') {
        timestamp = value;
      } else if (key === 'v1') {
        signatures.push(value);
      }
    }

    if (!timestamp || signatures.length === 0) {
      console.error('Invalid signature format');
      return false;
    }

    // Check timestamp is within tolerance (10 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 600) {
      console.error('Signature timestamp too old');
      return false;
    }

    // Prepare signature payload
    const signaturePayload = `${timestamp}.${JSON.stringify(payload)}`;

    // Compute expected signature
    const expectedSignature = crypto
      .createHmac('sha256', webhookToken)
      .update(signaturePayload)
      .digest('hex');

    // Compare signatures
    return signatures.includes(expectedSignature);
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

// Webhook handler
app.post('/', express.json(), async (req, res) => {
  console.log('🔔 Webhook received:', {
    headers: req.headers,
    body: JSON.stringify(req.body, null, 2)
  });

  try {
    // Verify webhook signature
    const signatureHeader = req.headers['blockfrost-signature'];
    if (!signatureHeader) {
      console.error('❌ Missing Blockfrost-Signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    if (!verifyBlockfrostSignature(signatureHeader, req.body, BLOCKFROST_WEBHOOK_TOKEN)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('✅ Webhook signature verified');

    // Process transactions
    const payload = req.body;
    for (const txData of payload.payload) {
      console.log('📦 Processing transaction:', txData.tx.hash);
      
      // Find payment to our address
      const outputs = txData.outputs;
      const paymentOutput = outputs.find(output => output.address === PAYMENT_ADDRESS);
      
      if (!paymentOutput) {
        console.log('⏭️ No payment to our address in this transaction');
        continue;
      }

      console.log('💰 Found payment to our address:', paymentOutput);

      // Get ADA amount
      const adaAmount = parseInt(paymentOutput.amount.find(asset => asset.unit === 'lovelace')?.quantity || '0');
      console.log('💵 ADA amount:', adaAmount / 1000000);

      // Find pending payment with this ADA amount
      const keys = await cache.keys('payment:*');
      for (const key of keys) {
        const payment = await getFromCache(key);
        if (!payment || payment.verified) continue;

        console.log('🔍 Checking payment record:', {
          expected: payment.adaAmount,
          received: adaAmount,
          userId: payment.userId
        });

        if (adaAmount === payment.adaAmount) {
          // Check BONE amount
          const boneAmount = parseInt(paymentOutput.amount.find(asset => 
            asset.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`
          )?.quantity || '0');

          if (boneAmount >= payment.boneAmount) {
            console.log('✨ Payment matched! Updating user slots:', {
              userId: payment.userId,
              txHash: txData.tx.hash
            });

            // Mark payment as verified
            payment.verified = true;
            payment.txHash = txData.tx.hash;
            payment.verifiedAt = Date.now();
            await setInCache(key, payment, 24 * 60 * 60);

            // Update user slots
            const userId = payment.userId;
            const currentSlots = await getUserSlots(userId);
            const newSlots = currentSlots + SLOTS_PER_PAYMENT;
            await updateUserSlots(userId, newSlots);

            // Notify clients
            if (global.clients) {
              for (const [clientId, client] of global.clients) {
                if (client.paymentId === key.split(':')[1]) {
                  try {
                    client.res.write(`data: ${JSON.stringify({
                      verified: true,
                      slots: newSlots,
                      txHash: txData.tx.hash
                    })}\n\n`);
                  } catch (error) {
                    console.error('Error notifying client:', error);
                  }
                }
              }
            }
          }
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
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
        console.log('Fetching account info for:', stake_address);

        // Get account info
        const accountInfo = await fetchBlockfrost(`/accounts/${stake_address}`, 'fetch account info');
        console.log('Account info:', accountInfo);

        if (accountInfo.pool_id) {
            try {
                // Get pool metadata
                const poolMetadata = await fetchBlockfrost(`/pools/${accountInfo.pool_id}/metadata`, 'fetch pool metadata');
                console.log('Pool metadata received:', poolMetadata);
                
                accountInfo.pool_info = {
                    id: accountInfo.pool_id,
                    metadata: {
                        name: poolMetadata.name,
                        ticker: poolMetadata.ticker,
                        description: poolMetadata.description,
                        homepage: poolMetadata.homepage
                    }
                };
            } catch (poolError) {
                console.error('Error fetching pool metadata:', poolError);
                // Fallback to just pool ID if metadata fetch fails
                accountInfo.pool_info = {
                    id: accountInfo.pool_id,
                    metadata: {
                        name: `Pool ${accountInfo.pool_id.substring(0,8)}...`,
                        ticker: `Pool ${accountInfo.pool_id.substring(0,8)}...`
                    }
                };
            }
        }

        console.log('Sending account info with pool info:', accountInfo.pool_info);
        res.json(accountInfo);
    } catch (error) {
        console.error('Error in /api/accounts/:stake_address:', error);
        res.status(500).json({ error: 'Failed to fetch account info' });
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
      try {
        const poolInfo = await fetchBlockfrost(`/pools/${accountInfo.pool_id}`, 'fetch pool info');
        console.log('Pool info received:', poolInfo);
      } catch (poolError) {
        console.error('Error fetching pool info:', poolError);
      }
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
