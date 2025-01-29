import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BLOCKFROST_API_KEY = process.env.BLOCKFROST_API_KEY;
const BLOCKFROST_BASE_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;

app.use(cors());
app.use(express.json());

// Middleware to verify origin
app.use((req, res, next) => {
  const origin = req.get('origin');
  // Only allow requests from Chrome extension
  if (origin && origin.startsWith('chrome-extension://')) {
    next();
  } else {
    res.status(403).json({ error: 'Unauthorized origin' });
  }
});

// Get wallet info
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${req.params.address}`, {
      headers: {
        'project_id': BLOCKFROST_API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch wallet data');
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify payment for slot unlock
app.get('/api/verify-payment/:address', async (req, res) => {
  try {
    // Get transactions for the payment address
    const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${PAYMENT_ADDRESS}/transactions?order=desc`, {
      headers: {
        'project_id': BLOCKFROST_API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch transaction data');
    }
    
    const transactions = await response.json();
    
    // Find transaction from the user's address
    const userTx = transactions.find(tx => tx.from === req.params.address);
    
    if (userTx && userTx.amount === 10000000) { // 10 ADA in lovelace
      res.json({ verified: true });
    } else {
      res.json({ verified: false });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
