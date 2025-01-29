// Constants
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 10;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 10;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

// Global state
let wallets = [];
let unlockedSlots = MAX_FREE_SLOTS;

// API Functions
async function fetchWalletData(address) {
  try {
    console.log('Fetching data for address:', address);
    const response = await fetch(`${API_BASE_URL}/api/wallet/${address}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Received wallet data:', data);
    return data;
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

async function verifyPayment(address) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${address}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error verifying payment:', error);
    throw error;
  }
}

// Storage Functions
async function loadWallets() {
  try {
    console.log('Loading wallets from storage...');
    const data = await chrome.storage.sync.get(['wallets', 'unlockedSlots']);
    wallets = data.wallets || [];
    unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;
    console.log('Loaded wallets:', wallets);
    console.log('Unlocked slots:', unlockedSlots);
  } catch (error) {
    console.error('Error loading wallets:', error);
    throw error;
  }
}

async function saveWallets() {
  try {
    await chrome.storage.sync.set({ wallets, unlockedSlots });
    console.log('Saved wallets:', wallets);
    console.log('Saved unlocked slots:', unlockedSlots);
  } catch (error) {
    console.error('Error saving wallets:', error);
    throw error;
  }
}

// UI Functions
function showError(message) {
  console.error('Error:', message);
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  document.getElementById('root').appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 3000);
}

function showSuccess(message) {
  console.log('Success:', message);
  const successDiv = document.createElement('div');
  successDiv.className = 'success';
  successDiv.textContent = message;
  document.getElementById('root').appendChild(successDiv);
  setTimeout(() => successDiv.remove(), 3000);
}

function validateAddress(address) {
  return address.startsWith('addr1') && address.length >= 59;
}

async function addWallet() {
  try {
    const addressInput = document.querySelector('#walletAddress');
    const nameInput = document.querySelector('#walletName');
    const address = addressInput.value.trim();
    const name = nameInput.value.trim();

    if (!validateAddress(address)) {
      showError('Invalid Cardano address');
      return;
    }

    if (wallets.length >= unlockedSlots) {
      showError('Maximum wallet slots reached. Please unlock more slots.');
      return;
    }

    console.log('Adding wallet:', { name, address });
    const walletData = await fetchWalletData(address);
    wallets.push({
      address,
      name,
      balance: walletData.balance,
      stake_address: walletData.stake_address,
      timestamp: Date.now()
    });

    await saveWallets();
    updateUI();
    addressInput.value = '';
    nameInput.value = '';
    showSuccess('Wallet added successfully!');
  } catch (error) {
    showError('Failed to add wallet: ' + error.message);
  }
}

function renderWallets() {
  if (wallets.length === 0) {
    return '<p class="status">No wallets added yet</p>';
  }

  return wallets.map(wallet => `
    <div class="wallet-item">
      <h3>${wallet.name}</h3>
      <p>Address: ${wallet.address.substring(0, 20)}...</p>
      <p>Balance: ${wallet.balance / 1000000} ADA</p>
      ${wallet.stake_address ? `<p>Stake Address: ${wallet.stake_address.substring(0, 20)}...</p>` : ''}
    </div>
  `).join('');
}

function updateUI() {
  const root = document.getElementById('root');
  if (!root) {
    console.error('Root element not found');
    return;
  }

  console.log('Updating UI...');
  root.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>Cardano Address Book</h1>
        <p>Available Slots: ${unlockedSlots - wallets.length} / ${unlockedSlots}</p>
      </div>
      
      <div class="input-group">
        <input type="text" id="walletAddress" placeholder="Enter Cardano Address" />
        <input type="text" id="walletName" placeholder="Enter Wallet Name" />
        <button id="addWallet">Add Wallet</button>
      </div>

      ${unlockedSlots < MAX_TOTAL_SLOTS ? `
        <button id="unlockSlots">Unlock More Slots (${ADA_PAYMENT_AMOUNT} ADA for ${SLOTS_PER_PAYMENT} slots)</button>
      ` : ''}

      <div class="wallet-list">
        ${renderWallets()}
      </div>
    </div>
  `;
  console.log('UI updated');
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('Extension popup opened');
    await loadWallets();
    updateUI();
    
    // Set up event listeners
    document.addEventListener('click', async (e) => {
      if (e.target.matches('#addWallet')) {
        await addWallet();
      } else if (e.target.matches('#unlockSlots')) {
        const paymentAddress = 'addr1qxdwefvjc4yw7sdtytmwx0lpp8sqsjdw5cl7kjcfz0zscdhl7mgsy7u7fva533d0uv7vctc8lh76hv5wgh7ascfwvmnqmsd04y';
        const instructions = document.createElement('div');
        instructions.innerHTML = `
          <div class="payment-instructions">
            <h3>Unlock More Slots</h3>
            <p>Send ${ADA_PAYMENT_AMOUNT} ADA to:</p>
            <code>${paymentAddress}</code>
            <p>You will receive ${SLOTS_PER_PAYMENT} additional wallet slots after payment confirmation.</p>
          </div>
        `;
        document.getElementById('root').appendChild(instructions);
      }
    });
  } catch (error) {
    console.error('Failed to initialize:', error);
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `<div class="error">Failed to initialize: ${error.message}</div>`;
    }
  }
});
