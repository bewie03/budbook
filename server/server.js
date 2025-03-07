const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth/google');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Constants
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
const REQUIRED_ADA_PAYMENT = 2; // 2 ADA required for activation
const SLOTS_PER_PAYMENT = 100; // Get 100 slots per payment
const BLOCKFROST_WEBHOOK_ID = process.env.BLOCKFROST_WEBHOOK_ID;
const BLOCKFROST_WEBHOOK_TOKEN = process.env.BLOCKFROST_WEBHOOK_TOKEN;

// Trust proxy - required for Heroku
app.set('trust proxy', 1);

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

app.use(limiter);
app.use(express.json());

// Authentication middleware
const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const user = await auth.verifyGoogleToken(token);
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Auth endpoints
app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;
    const userStatus = await auth.verifyGoogleToken(token);
    
    // Return user status with payment info if needed
    res.json({
      user: userStatus,
      message: userStatus.needsPayment ? 
        `Please send ${REQUIRED_ADA_PAYMENT} ADA to unlock ${SLOTS_PER_PAYMENT} wallet slots` : 
        `Account activated with ${SLOTS_PER_PAYMENT} slots`
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Get user status and slot info
app.get('/api/user/status', requireAuth, async (req, res) => {
  try {
    const status = await auth.checkPaymentStatus(req.user.id);
    res.json({
      ...status,
      message: status.paid ? 
        `You have ${status.slots} slots available` : 
        `Send ${REQUIRED_ADA_PAYMENT} ADA to unlock ${SLOTS_PER_PAYMENT} slots`
    });
  } catch (error) {
    console.error('Error getting user status:', error);
    res.status(500).json({ error: 'Failed to get user status' });
  }
});

// Generate payment ID for tracking
app.post('/api/payments/initiate', requireAuth, async (req, res) => {
  try {
    // Check if user has already paid
    const status = await auth.checkPaymentStatus(req.user.id);
    if (status.paid) {
      return res.status(400).json({ 
        error: 'Already activated',
        message: 'Your account is already activated with 100 slots'
      });
    }

    // Generate new payment tracking ID
    const payment = await auth.generatePaymentId(req.user.id);
    res.json({
      ...payment,
      message: `Please send exactly ${REQUIRED_ADA_PAYMENT} ADA to ${payment.paymentAddress}`,
      note: 'Your slots will be unlocked automatically after payment confirmation'
    });
  } catch (error) {
    console.error('Error initiating payment:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// Manual payment verification endpoint
app.post('/api/payments/verify/:paymentId', requireAuth, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const result = await auth.verifyPayment(paymentId);
    res.json({
      ...result,
      message: `Payment verified! You now have ${SLOTS_PER_PAYMENT} wallet slots available.`
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Wallet management endpoints
app.post('/api/wallets', requireAuth, async (req, res) => {
  try {
    const { address, label } = req.body;
    
    // Validate address
    if (!isValidCardanoAddress(address)) {
      return res.status(400).json({ error: 'Invalid Cardano address' });
    }

    const wallet = await db.addWallet(req.user.id, address, label);
    res.json(wallet);
  } catch (error) {
    console.error('Error adding wallet:', error);
    res.status(500).json({ error: 'Failed to add wallet' });
  }
});

app.get('/api/wallets', requireAuth, async (req, res) => {
  try {
    const wallets = await db.getUserWallets(req.user.id);
    res.json(wallets);
  } catch (error) {
    console.error('Error getting wallets:', error);
    res.status(500).json({ error: 'Failed to get wallets' });
  }
});

// Webhook endpoint for transaction monitoring
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['blockfrost-signature'];
    if (!verifyBlockfrostSignature(signature, req.rawBody, BLOCKFROST_WEBHOOK_TOKEN)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { type, payload } = req.body;
    if (type === 'transaction') {
      const txHash = payload.tx.hash;
      const tx = await fetchBlockfrost(`/txs/${txHash}`);
      
      // Process transaction outputs
      for (const output of tx.outputs) {
        if (output.address === PAYMENT_ADDRESS) {
          const lovelaceAmount = output.amount.find(a => a.unit === 'lovelace')?.quantity || 0;
          const adaAmount = parseInt(lovelaceAmount) / 1000000;
          
          if (adaAmount >= REQUIRED_ADA_PAYMENT) {
            const payment = await db.confirmPayment(txHash);
            if (payment) {
              await db.updatePaymentStatus(payment.user_id, true);
            }
          }
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Test webhook endpoint
app.post('/test-webhook', express.json(), (req, res) => {
  console.log(' Test webhook received:', {
    headers: req.headers,
    body: JSON.stringify(req.body, null, 2)
  });
  res.status(200).json({ status: 'ok', received: true });
});

// Serve favicon
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.ico'));
});

// Root route - handle both GET and POST
app.route('/')
  .get((req, res) => {
    res.json({
      status: 'ok',
      message: 'Cardano Address Book API Server',
      endpoints: {
        '/webhook': 'Blockfrost webhook endpoint',
        '/api/wallet/:address': 'Get wallet information',
        '/api/verify-payment/:paymentId': 'Verify payment for slot unlock'
      }
    });
  })
  .post((req, res) => {
    console.error('Received POST to root path instead of /webhook. Headers:', req.headers);
    console.error('Body:', JSON.stringify(req.body, null, 2));
    res.status(404).json({ 
      error: 'Not Found',
      message: 'Webhook endpoint is at /webhook, not /',
      received: {
        headers: req.headers,
        body: req.body
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

// Helper to resolve ADA Handle to address
async function resolveAdaHandle(handle) {
  try {
    // Remove the $ prefix if present
    handle = handle.replace(/^\$/, '');
    console.log(`Attempting to resolve ADA Handle: ${handle}`);
    
    const response = await fetch(`https://api.handle.me/handles/${handle}`);
    const responseText = await response.text();
    console.log(`Handle.me API Response: ${responseText}`);
    
    if (response.status === 200) {
      const data = JSON.parse(responseText);
      if (data && typeof data === 'object') {
        const resolved = data.resolved_addresses || {};
        const address = resolved.ada;
        if (address) {
          console.log(`Successfully resolved ${handle} to address: ${address}`);
          return address;
        }
      }
    }
    
    console.log(`Could not resolve ADA Handle: ${handle}`);
    return null;
  } catch (error) {
    console.error(`Error resolving ADA Handle ${handle}:`, error);
    return null;
  }
}

// Helper to validate Cardano address format
function isValidCardanoAddress(address) {
  // Check if it's an ADA handle
  if (address.startsWith('$')) {
    // We'll let the API endpoint handle the actual resolution
    return true;
  }

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
        let walletAddress = req.params.address;
        const forceRefresh = req.query.forceRefresh === 'true';
        console.log('Fetching wallet data for address:', walletAddress, 'Force refresh:', forceRefresh);
        
        // Check if address is an ADA Handle
        if (walletAddress.startsWith('$')) {
          const resolvedAddress = await resolveAdaHandle(walletAddress);
          if (resolvedAddress) {
            walletAddress = resolvedAddress;
          } else {
            return res.status(400).json({ error: 'Invalid ADA Handle' });
          }
        }

        if (!isValidCardanoAddress(walletAddress)) {
            console.error('Invalid address format:', walletAddress);
            return res.status(400).json({ error: 'Invalid Cardano address' });
        }

        // Clear asset caches if force refresh
        if (forceRefresh) {
            const cacheKeys = await cache.keys(`asset_${walletAddress}_*`);
            if (cacheKeys.length > 0) {
                await Promise.all(cacheKeys.map(key => cache.del(key)));
                console.log('Cleared asset caches:', cacheKeys.length);
            }
        }

        // 1. Get address data from Blockfrost
        console.log('Fetching address data from Blockfrost...');
        const addressData = await fetchBlockfrost(`/addresses/${walletAddress}`, 'fetch address data');
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
                const cacheKey = `asset_${walletAddress}_${amount.unit}`;
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

// Get user slots endpoint
app.get('/api/slots/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Read from slots.json first
    const slotsData = await fs.readFile(path.join(__dirname, 'slots.json'), 'utf8');
    const slotsJson = JSON.parse(slotsData);
    
    // If user doesn't exist, add them with default slots
    if (!slotsJson[userId]) {
      slotsJson[userId] = slotsJson.default;
      await fs.writeFile(path.join(__dirname, 'slots.json'), JSON.stringify(slotsJson, null, 2));
    }
    
    const userSlots = slotsJson[userId];
    console.log('Returning slots for user:', { userId, slots: userSlots });
    res.json({ slots: userSlots });
  } catch (error) {
    console.error('Error getting slots:', error);
    res.status(500).json({ error: 'Failed to get slots' });
  }
});

// Update slots after payment verification
async function updateUserSlots(userId, additionalSlots) {
  try {
    // Read current slots data
    const slotsPath = path.join(__dirname, 'slots.json');
    const slotsData = await fs.readFile(slotsPath, 'utf8');
    const slotsJson = JSON.parse(slotsData);
    
    // Calculate new slots
    const currentSlots = slotsJson[userId] || slotsJson.default || 5;
    const newSlots = Math.min(currentSlots + additionalSlots, 500);
    
    // Update slots.json
    slotsJson[userId] = newSlots;
    await fs.writeFile(slotsPath, JSON.stringify(slotsJson, null, 2));
    
    console.log('Updated slots:', { userId, oldSlots: currentSlots, newSlots });
    return newSlots;
  } catch (error) {
    console.error('Error updating slots:', error);
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
      boneAmount: 1,
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
      boneAmount: 1
    });

  } catch (error) {
    console.error('Error initiating payment:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// Helper function to verify payment amounts
function verifyPaymentAmounts(received, expected) {
  // Allow a small variance in lovelace amount for fees
  const lovelaceVariance = 100000; // Allow 0.1 ADA variance
  const receivedLovelace = BigInt(received.lovelace || '0');
  const expectedLovelace = BigInt(expected.lovelace || '0');
  const lovelaceDiff = receivedLovelace > expectedLovelace ? 
    receivedLovelace - expectedLovelace : 
    expectedLovelace - receivedLovelace;

  // Bone amount must match exactly
  const boneMatches = received.bone === expected.bone;
  
  // Lovelace amount can be within variance
  const lovelaceMatches = lovelaceDiff <= BigInt(lovelaceVariance);

  console.log('Payment amount verification:', {
    lovelace: {
      received: receivedLovelace.toString(),
      expected: expectedLovelace.toString(),
      difference: lovelaceDiff.toString(),
      matches: lovelaceMatches
    },
    bone: {
      received: received.bone,
      expected: expected.bone,
      matches: boneMatches
    }
  });

  return boneMatches && lovelaceMatches;
}

// Payment verification function
async function verifyPayment(txHash, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 seconds

    try {
        console.log(`Verifying payment for txHash: ${txHash} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
        
        // Get transaction details from Blockfrost
        const tx = await fetchBlockfrost(`/txs/${txHash}/utxos`, 'verify payment');
        if (!tx || !tx.outputs) {
            console.error('Failed to fetch transaction details');
            
            // Retry logic for failed fetches
            if (retryCount < MAX_RETRIES) {
                console.log(`Retrying verification in ${RETRY_DELAY/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return verifyPayment(txHash, retryCount + 1);
            }
            return false;
        }

        // Find payment to our address
        const paymentOutput = tx.outputs.find(output => {
            if (output.address !== PAYMENT_ADDRESS) return false;
            
            // Get payment amounts
            const lovelaceAmount = output.amount.find(a => a.unit === 'lovelace')?.quantity || '0';
            const boneAmount = output.amount.find(a => a.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`)?.quantity || '0';
            
            // Check payment amounts with allowed variance
            const received = { lovelace: lovelaceAmount, bone: boneAmount };
            const expected = { lovelace: '1976642', bone: '1' }; // Updated to match actual payment amount
            
            console.log('Checking payment amounts:', {
                expected,
                received
            });
            
            return verifyPaymentAmounts(received, expected);
        });
        
        if (!paymentOutput) {
            console.log('No matching payment found in transaction outputs');
            return false;
        }

        console.log('Found valid payment output:', paymentOutput);
        
        // Get transaction status
        const txStatus = await fetchBlockfrost(`/txs/${txHash}`, 'get transaction status');
        console.log('Transaction status:', txStatus);
        
        if (txStatus.block_height) {
            console.log('Transaction is confirmed in block:', txStatus.block_height);
        } else {
            console.log('Transaction is not yet confirmed');
            if (retryCount < MAX_RETRIES) {
                console.log(`Retrying verification in ${RETRY_DELAY/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return verifyPayment(txHash, retryCount + 1);
            }
            return false;
        }
            
        // Get all payment keys from cache
        const keys = await cache.keys('payment:*');
        console.log('Found payment keys:', keys);
        
        // Find matching payment
        for (const key of keys) {
            if (!key.startsWith('payment:')) continue;
            
            const payment = await getFromCache(key);
            console.log('Checking payment:', payment);
            
            if (payment && !payment.verified) {
                console.log('Found matching unverified payment:', key);
                
                // Verify payment amounts match what was expected
                const received = { 
                    lovelace: paymentOutput.amount.find(a => a.unit === 'lovelace')?.quantity || '0',
                    bone: paymentOutput.amount.find(a => a.unit === `${BONE_POLICY_ID}${BONE_ASSET_NAME}`)?.quantity || '0'
                };
                const expected = {
                    lovelace: payment.adaAmount.toString(),
                    bone: payment.boneAmount.toString()
                };
                
                if (!verifyPaymentAmounts(received, expected)) {
                    console.log('Payment amounts do not match expected values');
                    continue;
                }
                
                // Update payment status with more details
                payment.verified = true;
                payment.txHash = txHash;
                payment.verifiedAt = new Date().toISOString();
                payment.blockHeight = txStatus.block_height;
                payment.blockTime = txStatus.block_time;
                await setInCache(key, payment);
                
                // Update user slots
                const currentSlots = await updateUserSlots(payment.userId, 5);
                console.log(`Updated slots for user ${payment.userId}: ${currentSlots}`);
                
                return true;
            }
        }
        
        console.log('No matching unverified payment found in cache');
        return false;
    } catch (error) {
        console.error('Error verifying payment:', error);
        
        // Retry on error
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying verification in ${RETRY_DELAY/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return verifyPayment(txHash, retryCount + 1);
        }
        return false;
    }
}

// Payment verification endpoint - supports both payment IDs and tx hashes
app.get('/api/verify-payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    console.log('Verification request for:', paymentId);
    
    const payment = await getFromCache(`payment:${paymentId}`);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // If already verified, return the current slots
    if (payment.verified) {
      const currentSlots = await updateUserSlots(payment.userId, 0);
      return res.json({ 
        verified: true,
        slots: currentSlots,
        txHash: payment.txHash 
      });
    }

    res.json({ verified: false });
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

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    console.log('Webhook received:', {
        method: req.method,
        url: req.url,
        headers: req.headers,
        signature: req.headers['blockfrost-signature'],
        bodyLength: req.rawBody?.length,
        timestamp: new Date().toISOString()
    });

    try {
        // Verify webhook signature
        const signature = req.headers['blockfrost-signature'];
        if (!signature) {
            console.error('Missing Blockfrost signature header');
            return res.status(401).json({ error: 'Missing signature' });
        }

        if (!verifyBlockfrostSignature(signature, req.rawBody, BLOCKFROST_WEBHOOK_TOKEN)) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Process webhook payload
        const payload = req.body;
        if (!payload || !payload.type) {
            console.error('Invalid webhook payload:', payload);
            return res.status(400).json({ error: 'Invalid payload' });
        }

        console.log('Processing webhook payload:', {
            type: payload.type,
            payloadCount: payload.payload?.length || 0,
            timestamp: new Date().toISOString()
        });

        // Handle transaction events
        if (payload.type === 'transaction') {
            if (!Array.isArray(payload.payload)) {
                console.error('Invalid transaction payload format');
                return res.status(400).json({ error: 'Invalid payload format' });
            }

            const results = [];
            for (const tx of payload.payload) {
                try {
                    console.log('Processing transaction:', {
                        hash: tx.tx.hash,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Find outputs to our payment address
                    const outputs = tx.outputs.filter(o => o.address === PAYMENT_ADDRESS);
                    if (outputs.length > 0) {
                        console.log('Found outputs to payment address:', outputs.length);
                        
                        // Process each output
                        for (const output of outputs) {
                            const lovelaceAmount = parseInt(output.amount.find(a => a.unit === 'lovelace')?.quantity || '0');
                            const requiredLovelace = REQUIRED_ADA_PAYMENT * 1_000_000; // Convert ADA to lovelace
                            
                            console.log('Payment received:', {
                                tx: tx.tx.hash,
                                lovelace: lovelaceAmount,
                                required: requiredLovelace,
                                timestamp: new Date().toISOString()
                            });

                            // Check if this is exactly 2 ADA (2_000_000 lovelace)
                            if (lovelaceAmount === requiredLovelace) {
                                // Look for payment record with this address
                                const paymentKey = `payment:${tx.tx.hash}`;
                                const existingPayment = await getFromCache(paymentKey);
                                
                                if (existingPayment && !existingPayment.verified) {
                                    console.log('Found matching payment record:', existingPayment);
                                    
                                    // Update payment status
                                    const updatedPayment = {
                                        ...existingPayment,
                                        verified: true,
                                        verifiedAt: new Date().toISOString(),
                                        txHash: tx.tx.hash
                                    };
                                    
                                    // Save verified payment
                                    await setInCache(paymentKey, updatedPayment);
                                    
                                    // Update user's slot count in database
                                    await db.query(`
                                        UPDATE users
                                        SET payment_status = true,
                                            slot_count = SLOTS_PER_PAYMENT,
                                            updated_at = CURRENT_TIMESTAMP
                                        WHERE id = $1
                                    `, [existingPayment.userId]);
                                    
                                    // Notify connected clients about payment verification
                                    if (global.clients) {
                                        for (const [clientId, client] of global.clients.entries()) {
                                            if (client.paymentId === existingPayment.paymentId) {
                                                try {
                                                    client.res.write(`data: ${JSON.stringify({
                                                        verified: true,
                                                        slots: SLOTS_PER_PAYMENT,
                                                        message: `Payment verified! You now have ${SLOTS_PER_PAYMENT} wallet slots.`
                                                    })}\n\n`);
                                                } catch (error) {
                                                    console.error('Error notifying client:', error);
                                                    global.clients.delete(clientId);
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            results.push({
                                txHash: tx.tx.hash,
                                amount: lovelaceAmount,
                                verified: lovelaceAmount === REQUIRED_ADA_PAYMENT * 1_000_000,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                } catch (txError) {
                    console.error('Error processing transaction:', tx.tx.hash, txError);
                    results.push({
                        txHash: tx.tx.hash,
                        error: txError.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            return res.json({
                status: 'ok',
                processed: results.length,
                results,
                timestamp: new Date().toISOString()
            });
        }

        // Handle other webhook types
        console.log('Unhandled webhook type:', payload.type);
        res.json({ 
            status: 'ok',
            message: `Received ${payload.type} webhook`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook',
            message: error.message,
            timestamp: new Date().toISOString()
        });
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

// Function to verify Blockfrost webhook signature
function verifyBlockfrostSignature(signatureHeader, rawPayload, webhookToken) {
  try {
    if (!signatureHeader) {
      console.error('No Blockfrost-Signature header');
      return false;
    }

    // Parse the header
    const elements = signatureHeader.split(',');
    const signatures = new Map(); // Store multiple timestamp-signature pairs

    // Extract all timestamp-signature pairs
    for (const element of elements) {
      const [key, value] = element.split('=');
      if (key === 't') {
        signatures.set('timestamp', value);
      } else if (key.startsWith('v')) { // Support multiple signature versions
        signatures.set(key, value);
      }
    }

    const timestamp = signatures.get('timestamp');
    if (!timestamp) {
      console.error('Missing timestamp in signature header');
      return false;
    }

    if (!signatures.has('v1')) {
      console.error('Missing v1 signature in header');
      return false;
    }

    // Check timestamp tolerance (10 minutes)
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - parseInt(timestamp));
    if (timeDiff > 600) {
      console.error('Signature timestamp too old:', {
        now,
        timestamp,
        difference: timeDiff,
        maxAllowed: 600
      });
      return false;
    }

    // Parse and re-stringify the JSON payload to ensure consistent formatting
    let formattedPayload;
    try {
      const parsedPayload = JSON.parse(rawPayload);
      formattedPayload = JSON.stringify(parsedPayload);
    } catch (e) {
      console.error('Failed to parse/format payload:', e);
      formattedPayload = rawPayload; // Fallback to raw payload if parsing fails
    }

    // Create signature payload
    const signaturePayload = `${timestamp}.${formattedPayload}`;

    // Compute expected signature using HMAC-SHA256
    const hmac = crypto.createHmac('sha256', webhookToken);
    hmac.update(signaturePayload);
    const expectedSignature = hmac.digest('hex');

    // Log detailed debug information
    console.log('Webhook verification details:', {
      timestamp,
      receivedSignatures: Object.fromEntries(signatures),
      expectedSignature,
      payloadLength: formattedPayload.length,
      payloadPreview: formattedPayload.substring(0, 100) + '...',
      webhookTokenLength: webhookToken.length
    });

    // Check all supported signature versions
    for (const [version, signature] of signatures) {
      if (version === 'timestamp') continue;

      try {
        // Convert hex strings to buffers for comparison
        const receivedBuffer = Buffer.from(signature, 'hex');
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');

        // Compare signatures using timing-safe comparison
        const isValid = receivedBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

        if (isValid) {
          console.log('Valid signature found:', { version });
          return true;
        }
      } catch (e) {
        console.error('Error comparing signatures:', {
          version,
          error: e.message
        });
      }
    }

    // If we get here, no valid signatures were found
    console.error('No valid signatures found:', {
      received: Object.fromEntries(signatures),
      expected: expectedSignature,
      timestamp,
      signaturePayload: signaturePayload.substring(0, 100) + '...' // Log only first 100 chars
    });

    return false;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

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
