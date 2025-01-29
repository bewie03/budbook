// Constants
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 10;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 10;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

// Available wallet logos
const WALLET_LOGOS = {
  'Nami': 'icons/Nami.png',
  'Eternal': 'icons/Eternal.png',
  'Lace': 'icons/lace.png',
  'Gero': 'icons/gero.png',
  'Vesper': 'icons/Vesper.png',
  'AdaLite': 'icons/Adalite.png',
  'Daedalus': 'icons/daedalus.png',
  'Custom': 'custom'
};

// Global state
let wallets = [];
let unlockedSlots = MAX_FREE_SLOTS;
let customLogoData = null;

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
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error';
  errorDiv.textContent = message;
  document.getElementById('root')?.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 3000);
}

function showSuccess(message) {
  console.log('Success:', message);
  const successDiv = document.createElement('div');
  successDiv.className = 'success';
  successDiv.textContent = message;
  document.getElementById('root')?.appendChild(successDiv);
  setTimeout(() => successDiv.remove(), 3000);
}

function validateAddress(address) {
  return address && address.startsWith('addr1') && address.length >= 59;
}

async function handleCustomLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addWallet() {
  try {
    const addressInput = document.querySelector('#walletAddress');
    const nameInput = document.querySelector('#walletName');
    const walletSelect = document.querySelector('#walletType');
    
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

    // Handle custom logo upload
    let logoPath = WALLET_LOGOS[selectedWallet];
    if (selectedWallet === 'Custom' && customLogoData) {
      logoPath = customLogoData;
    }

    wallets.push({
      address,
      name,
      balance: walletData.balance || 0,
      stake_address: walletData.stake_address,
      timestamp: Date.now(),
      walletType: selectedWallet,
      logo: logoPath
    });

    await saveWallets();
    updateUI();
    addressInput.value = '';
    nameInput.value = '';
    walletSelect.value = 'Nami'; // Reset to default
    customLogoData = null;
    showSuccess('Wallet added successfully!');
  } catch (error) {
    showError(error.message || 'Failed to add wallet');
  }
}

function renderWallets() {
  if (!wallets.length) {
    return '<p class="status">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => `
    <div class="wallet-item">
      <button class="delete delete-btn" data-index="${index}">×</button>
      <div class="wallet-header">
        <img src="${wallet.logo}" alt="${wallet.walletType}" class="wallet-logo">
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
    <select id="walletType" class="wallet-select">
      ${Object.keys(WALLET_LOGOS).map(wallet => 
        `<option value="${wallet}">${wallet}</option>`
      ).join('')}
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

  console.log('Updating UI...');
  root.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>Cardano Address Book</h1>
        <p class="slots">Available Slots: ${unlockedSlots - wallets.length} / ${unlockedSlots}</p>
      </div>
      
      <div class="input-group">
        <input type="text" id="walletAddress" placeholder="Enter Cardano Address" />
        <input type="text" id="walletName" placeholder="Enter Wallet Name" />
        ${renderWalletSelector()}
        <button id="addWallet" class="primary">Add Wallet</button>
        <input type="file" id="customLogo" style="display: none;">
      </div>

      ${unlockedSlots < MAX_TOTAL_SLOTS ? `
        <button id="unlockSlots" class="secondary">
          Unlock ${SLOTS_PER_PAYMENT} More Slots (${ADA_PAYMENT_AMOUNT} ₳)
        </button>
      ` : ''}

      <div class="wallet-list">
        ${renderWallets()}
      </div>
    </div>
  `;

  // Add event listeners
  document.getElementById('addWallet')?.addEventListener('click', addWallet);
  
  // Add delete button listeners
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      if (!isNaN(index)) {
        deleteWallet(index);
      }
    });
  });

  // Add wallet type change listener
  document.getElementById('walletType')?.addEventListener('change', (e) => {
    if (e.target.value === 'Custom') {
      document.getElementById('customLogo')?.click();
    }
  });

  // Add custom logo upload listener
  document.getElementById('customLogo')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        customLogoData = await handleCustomLogo(file);
        showSuccess('Custom logo uploaded!');
      } catch (error) {
        showError('Failed to upload custom logo');
        document.getElementById('walletType').value = 'Nami';
      }
    }
  });

  document.getElementById('unlockSlots')?.addEventListener('click', () => {
    const paymentAddress = 'addr1qxdwefvjc4yw7sdtytmwx0lpp8sqsjdw5cl7kjcfz0zscdhl7mgsy7u7fva533d0uv7vctc8lh76hv5wgh7ascfwvmnqmsd04y';
    const instructions = document.createElement('div');
    instructions.className = 'payment-instructions';
    instructions.innerHTML = `
      <div class="modal">
        <h3>Unlock More Slots</h3>
        <p>Send ${ADA_PAYMENT_AMOUNT} ₳ to:</p>
        <code>${paymentAddress}</code>
        <p>You will receive ${SLOTS_PER_PAYMENT} additional wallet slots after payment confirmation.</p>
        <button class="close">Close</button>
      </div>
    `;
    root.appendChild(instructions);
    instructions.querySelector('.close')?.addEventListener('click', () => {
      instructions.remove();
    });
  });
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
        <div class="error">
          Failed to initialize: ${error.message}
          <button onclick="location.reload()">Retry</button>
        </div>
      `;
    }
  }
});
