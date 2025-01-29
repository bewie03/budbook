// Constants
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 10;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 10;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

// Available wallet logos
const WALLET_LOGOS = {
  'None': '',
  'Nami': 'icons/Nami.png',
  'Eternal': 'icons/Eternal.png',
  'Adalite': 'icons/Adalite.png',
  'Vesper': 'icons/Vesper.png',
  'Daedalus': 'icons/daedalus.png',
  'Gero': 'icons/gero.png',
  'Lace': 'icons/lace.png'
};

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
        'Content-Type': 'application/json',
        'Origin': chrome.runtime.getURL('')
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
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
        'Accept': 'application/json',
        'Origin': chrome.runtime.getURL('')
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error verifying payment:', error);
    throw error;
  }
}

// Storage Functions
async function loadWallets() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.sync.get(['wallets', 'unlockedSlots'], (data) => {
        if (chrome.runtime.lastError) {
          console.error('Error loading from storage:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        console.log('Loaded from storage:', data);
        wallets = data.wallets || [];
        unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;
        resolve();
      });
    } catch (error) {
      console.error('Error in loadWallets:', error);
      reject(error);
    }
  });
}

async function saveWallets() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.sync.set({ wallets, unlockedSlots }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error saving to storage:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        console.log('Saved to storage:', { wallets, unlockedSlots });
        resolve();
      });
    } catch (error) {
      console.error('Error in saveWallets:', error);
      reject(error);
    }
  });
}

// UI Functions
function showError(message) {
  console.error('Error:', message);
  const errorDiv = document.getElementById('errorMsg');
  errorDiv.textContent = message;
  errorDiv.style.display = 'block';
  setTimeout(() => errorDiv.style.display = 'none', 3000);
}

function showSuccess(message) {
  console.log('Success:', message);
  const successDiv = document.getElementById('successMsg');
  successDiv.textContent = message;
  successDiv.style.display = 'block';
  setTimeout(() => successDiv.style.display = 'none', 3000);
}

function validateAddress(address) {
  return address && address.startsWith('addr1') && address.length >= 59;
}

async function addWallet() {
  try {
    const addressInput = document.getElementById('addressInput');
    const nameInput = document.getElementById('nameInput');
    const walletSelect = document.getElementById('walletType');
    
    if (!addressInput || !nameInput || !walletSelect) {
      throw new Error('UI elements not found');
    }

    const address = addressInput.value.trim();
    const name = nameInput.value.trim();
    const selectedWallet = walletSelect.value;

    if (!validateAddress(address)) {
      showError('Invalid Cardano address');
      return;
    }

    if (!name) {
      showError('Please enter a wallet name');
      return;
    }

    if (wallets.length >= unlockedSlots) {
      showError('Maximum wallet slots reached. Please unlock more slots.');
      return;
    }

    if (wallets.some(w => w.address === address)) {
      showError('This wallet is already in your address book');
      return;
    }

    console.log('Adding wallet:', { name, address, selectedWallet });
    const walletData = await fetchWalletData(address);

    wallets.push({
      address,
      name,
      balance: walletData.balance || 0,
      stake_address: walletData.stake_address,
      timestamp: Date.now(),
      walletType: selectedWallet,
      logo: WALLET_LOGOS[selectedWallet]
    });

    await saveWallets();
    updateUI();
    addressInput.value = '';
    nameInput.value = '';
    walletSelect.value = 'None';
    showSuccess('Wallet added successfully!');
  } catch (error) {
    showError(error.message || 'Failed to add wallet');
  }
}

function renderWallets() {
  if (!wallets.length) {
    return '<p style="text-align: center; color: #808080; font-style: italic;">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => `
    <div class="wallet-item">
      <button class="delete delete-btn" data-index="${index}">×</button>
      <div class="wallet-header">
        ${wallet.walletType !== 'None' && WALLET_LOGOS[wallet.walletType] ? 
          `<img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}" class="wallet-logo">` : 
          ''}
        <h3>${wallet.name}</h3>
      </div>
      <p class="address">Address: ${wallet.address.substring(0, 20)}...</p>
      <p class="balance">Balance: ${(wallet.balance / 1000000).toFixed(2)} ₳</p>
      ${wallet.stake_address ? 
        `<p class="stake">Stake Address: ${wallet.stake_address.substring(0, 20)}...</p>` : 
        ''}
      <p class="timestamp">Added: ${new Date(wallet.timestamp).toLocaleString()}</p>
    </div>
  `).join('');
}

function renderWalletSelector() {
  return `
    <select id="walletType">
      ${Object.entries(WALLET_LOGOS).map(([name, logo]) => `
        <option value="${name}" ${name === 'None' ? 'selected' : ''}>
          ${name}
        </option>
      `).join('')}
    </select>
  `;
}

async function deleteWallet(index) {
  try {
    wallets.splice(index, 1);
    await saveWallets();
    updateUI();
    showSuccess('Wallet removed successfully!');
  } catch (error) {
    showError('Failed to remove wallet');
  }
}

function updateUI() {
  const root = document.getElementById('root');
  if (!root) {
    console.error('Root element not found');
    return;
  }

  root.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>Cardano Address Book</h1>
        <p class="slots">Available Slots: ${wallets.length} / ${unlockedSlots}</p>
      </div>
      
      <div class="input-group">
        <input type="text" id="addressInput" placeholder="Enter Cardano Address" autocomplete="off">
        <input type="text" id="nameInput" placeholder="Enter Wallet Name" autocomplete="off">
        ${renderWalletSelector()}
        <button class="primary" id="addWallet">Add Wallet</button>
      </div>

      <div id="errorMsg" class="error" style="display: none;"></div>
      <div id="successMsg" class="success" style="display: none;"></div>
      
      <div id="walletList" class="wallet-list">
        ${renderWallets()}
      </div>
      
      ${unlockedSlots < MAX_TOTAL_SLOTS ? 
        `<button class="secondary" id="unlockButton">Unlock 10 More Slots (10 ₳)</button>` : 
        ''}
    </div>
  `;

  setupEventListeners();
}

function setupEventListeners() {
  const addWalletBtn = document.getElementById('addWallet');
  if (addWalletBtn) {
    addWalletBtn.addEventListener('click', addWallet);
  }

  const deleteButtons = document.querySelectorAll('.delete-btn');
  deleteButtons.forEach(button => {
    const index = button.dataset.index;
    if (index !== undefined) {
      button.addEventListener('click', () => deleteWallet(parseInt(index)));
    }
  });

  const unlockButton = document.getElementById('unlockButton');
  if (unlockButton) {
    unlockButton.addEventListener('click', () => {
      const paymentAddress = 'addr1qxdwefvjc4yw7sdtytmwx0lpp8sqsjdw5cl7kjcfz0zscdhl7mgsy7u7fva533d0uv7vctc8lh76hv5wgh7ascfwvmnqmsd04y';
      const instructions = document.createElement('div');
      instructions.className = 'payment-instructions';
      instructions.innerHTML = `
        <div class="modal">
          <h3>Unlock More Slots</h3>
          <p>Send 10 ₳ to:</p>
          <code>${paymentAddress}</code>
          <p>You will receive 10 additional wallet slots after payment confirmation.</p>
          <button class="close">Close</button>
        </div>
      `;
      
      const root = document.getElementById('root');
      if (root) {
        root.appendChild(instructions);
        const closeBtn = instructions.querySelector('.close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => instructions.remove());
        }
      }
    });
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('Extension popup opened');
    await loadWallets();
    updateUI();
  } catch (error) {
    console.error('Failed to initialize:', error);
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `
        <div class="container">
          <div class="error" style="margin: 20px;">
            Failed to initialize: ${error.message}
            <button class="primary" style="margin-top: 10px;" onclick="location.reload()">Retry</button>
          </div>
        </div>
      `;
    }
  }
});
