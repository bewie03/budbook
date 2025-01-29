// Import the shared constants and functions
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 10;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 10;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

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

let wallets = [];
let unlockedSlots = MAX_FREE_SLOTS;

// Reuse the same functions from popup.js
async function fetchWalletData(address) {
  try {
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
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

async function loadWallets() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(['wallets', 'unlockedSlots'], (data) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        wallets = data.wallets || [];
        unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function saveWallets() {
  return new Promise((resolve, reject) => {
    try {
      // Clean up wallet data before saving
      const cleanWallets = wallets.map(wallet => ({
        address: wallet.address,
        name: wallet.name,
        balance: wallet.balance,
        stake_address: wallet.stake_address,
        timestamp: wallet.timestamp,
        walletType: wallet.walletType,
        logo: wallet.logo,
        assets: wallet.assets ? wallet.assets.map(asset => ({
          unit: asset.unit,
          quantity: asset.quantity,
          display_name: asset.display_name,
          asset_name: asset.asset_name,
          onchain_metadata: asset.onchain_metadata ? {
            name: asset.onchain_metadata.name,
            image: asset.onchain_metadata.image
          } : null
        })) : []
      }));

      chrome.storage.local.set({ 
        wallets: cleanWallets, 
        unlockedSlots 
      }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error('Error saving to storage: ' + chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function showError(message) {
  const errorDiv = document.getElementById('errorMsg');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.classList.add('visible');
    setTimeout(() => {
      errorDiv.classList.remove('visible');
    }, 3000);
  }
}

function showSuccess(message) {
  const successDiv = document.getElementById('successMsg');
  if (successDiv) {
    successDiv.textContent = message;
    successDiv.classList.add('visible');
    setTimeout(() => {
      successDiv.classList.remove('visible');
    }, 3000);
  }
}

function validateAddress(address) {
  return address && address.startsWith('addr1') && address.length >= 59;
}

function convertIpfsUrl(url) {
  if (!url || typeof url !== 'string') return '';
  
  // Handle ipfs:// protocol
  if (url.startsWith('ipfs://')) {
    const hash = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${hash}`;
  }
  
  // If it's already a gateway URL, return as is
  if (url.includes('/ipfs/')) {
    return url;
  }
  
  // If it looks like a raw IPFS hash, add the gateway prefix
  if (url.startsWith('Qm') || url.startsWith('bafy')) {
    return `https://ipfs.io/ipfs/${url}`;
  }
  
  return url;
}

function truncateAddress(address, startLength = 8, endLength = 8) {
  if (!address) return '';
  if (address.length <= startLength + endLength) return address;
  return `${address.slice(0, startLength)}...${address.slice(-endLength)}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showSuccess('Copied to clipboard!');
  } catch (err) {
    console.error('Failed to copy:', err);
    showError('Failed to copy to clipboard');
  }
}

function renderWallets() {
  if (!wallets.length) {
    return '<p class="no-wallets">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => `
    <div class="wallet-item">
      <div class="wallet-actions">
        <button class="refresh-btn" data-index="${index}" title="Refresh Balance">↻</button>
        <button class="delete delete-btn" data-index="${index}">×</button>
      </div>
      
      <div class="wallet-header">
        ${wallet.walletType !== 'None' && WALLET_LOGOS[wallet.walletType] ? 
          `<img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}" class="wallet-logo">` : 
          ''}
        <h3>${wallet.name}</h3>
      </div>
      
      <div class="address-group">
        <div class="address-label">Address</div>
        <div class="address-container">
          <span class="address">${truncateAddress(wallet.address)}</span>
          <button class="copy-btn" data-copy="${wallet.address}" title="Copy Address">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
      </div>

      <div class="balance-container">
        <span class="balance">${(parseInt(wallet.balance) / 1000000).toFixed(2)} ₳</span>
      </div>
      
      ${wallet.stake_address ? `
        <div class="address-group">
          <div class="address-label">Stake Address</div>
          <div class="address-container">
            <span class="stake">${truncateAddress(wallet.stake_address)}</span>
            <button class="copy-btn" data-copy="${wallet.stake_address}" title="Copy Stake Address">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        </div>
      ` : ''}
      
      ${wallet.assets && wallet.assets.length > 0 ? `
        <button class="assets-toggle" data-index="${index}">
          <span class="arrow">▼</span>
          Assets (${wallet.assets.length})
        </button>
        <div class="assets" id="assets-${index}">
          <div class="assets-list">
            ${wallet.assets.map(asset => `
              <div class="asset-item" title="${asset.unit}">
                <span class="asset-quantity">${asset.quantity}×</span>
                <span class="asset-name">${
                  asset.display_name || 
                  asset.asset_name || 
                  truncateAddress(asset.unit, 6, 6)
                }</span>
                ${asset.onchain_metadata?.image ? 
                  `<img src="${convertIpfsUrl(asset.onchain_metadata.image)}" alt="${asset.display_name || 'Asset'}" class="asset-image">` : 
                  ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      
      <p class="timestamp">Last updated: ${new Date(wallet.timestamp).toLocaleString()}</p>
    </div>
  `).join('');
}

async function refreshWallet(index) {
  try {
    const wallet = wallets[index];
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    showSuccess('Refreshing wallet data...');
    const walletData = await fetchWalletData(wallet.address);
    
    wallet.balance = walletData.balance;
    wallet.assets = walletData.assets;
    wallet.timestamp = Date.now();
    
    await saveWallets();
    updateUI();
    showSuccess('Wallet data updated!');
  } catch (error) {
    showError(error.message || 'Failed to refresh wallet');
  }
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

    const walletData = await fetchWalletData(address);

    wallets.push({
      address,
      name,
      balance: walletData.balance || 0,
      stake_address: walletData.stake_address,
      timestamp: Date.now(),
      walletType: selectedWallet,
      logo: WALLET_LOGOS[selectedWallet],
      assets: walletData.assets || []
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

function updateUI() {
  const walletListElement = document.getElementById('walletList');
  if (!walletListElement) {
    console.error('Wallet list element not found');
    return;
  }

  walletListElement.innerHTML = renderWallets();
  setupEventListeners();
}

function setupEventListeners() {
  // Add copy button listeners
  document.querySelectorAll('.copy-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const textToCopy = button.dataset.copy;
      if (textToCopy) {
        await copyToClipboard(textToCopy);
      }
    });
  });

  // Add refresh button listeners
  document.querySelectorAll('.refresh-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const index = parseInt(button.dataset.index);
      if (!isNaN(index)) {
        await refreshWallet(index);
      }
    });
  });

  // Add delete button listeners
  document.querySelectorAll('.delete-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const index = parseInt(button.dataset.index);
      if (!isNaN(index)) {
        await deleteWallet(index);
      }
    });
  });

  // Add asset toggle listeners
  document.querySelectorAll('.assets-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const index = toggle.dataset.index;
      const assets = document.getElementById(`assets-${index}`);
      if (assets) {
        assets.classList.toggle('expanded');
        toggle.classList.toggle('expanded');
      }
    });
  });
}

async function deleteWallet(index) {
  try {
    wallets.splice(index, 1);
    await saveWallets();
    updateUI();
    showSuccess('Wallet deleted successfully!');
  } catch (error) {
    showError('Failed to delete wallet');
  }
}

function renderWalletSelector() {
  return Object.entries(WALLET_LOGOS).map(([name, logo]) => `
    <option value="${name}" ${name === 'None' ? 'selected' : ''}>
      ${name}
    </option>
  `).join('');
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    
    // Initialize wallet type selector
    const walletTypeSelect = document.getElementById('walletType');
    if (walletTypeSelect) {
      walletTypeSelect.innerHTML = renderWalletSelector();
    }
    
    updateUI();
  } catch (error) {
    console.error('Failed to initialize:', error);
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `
        <div class="container">
          <div class="error-container">
            <div class="error visible">
              Failed to initialize: ${error.message}
            </div>
            <button class="primary retry-button" onclick="location.reload()">Retry</button>
          </div>
        </div>
      `;
    }
  }
});
