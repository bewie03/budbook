// Constants
const MAX_FREE_SLOTS = 6;
const SLOTS_PER_PAYMENT = 6;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 2;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

// Available wallet logos
const WALLET_LOGOS = {
  'None': '',
  'Nami': 'icons/nami.png',
  'Eternal': 'icons/eternal.png',
  'Adalite': 'icons/adalite.png',
  'Vesper': 'icons/vesper.png',
  'Daedalus': 'icons/daedalus.png',
  'Gero': 'icons/gero.png',
  'Lace': 'icons/lace.png'
};

// Global state
let wallets = [];
let unlockedSlots = MAX_FREE_SLOTS;
let currentPaymentId = null;

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

async function verifyPayment(paymentId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`, {
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

async function requestPayment() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/request-payment`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': chrome.runtime.getURL('')
      }
    });

    if (!response.ok) {
      throw new Error('Failed to generate payment request');
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error requesting payment:', error);
    throw error;
  }
}

// Storage Functions
async function loadWallets() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.sync.get(['wallet_index', 'unlockedSlots'], async (data) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        
        // Load wallet index
        const walletIndex = data.wallet_index || [];
        unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;

        // Load each wallet individually
        const walletPromises = walletIndex.map(address => 
          new Promise((resolve) => {
            chrome.storage.sync.get(`wallet_${address}`, (result) => {
              resolve(result[`wallet_${address}`]);
            });
          })
        );

        wallets = (await Promise.all(walletPromises)).filter(Boolean);
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
      // Create a wallet index (just addresses)
      const walletIndex = wallets.map(w => w.address);

      // Prepare individual wallet saves
      const savePromises = wallets.map(wallet => 
        new Promise((resolve, reject) => {
          // Clean up wallet data before saving
          const cleanWallet = {
            address: wallet.address,
            name: wallet.name,
            balance: wallet.balance,
            stake_address: wallet.stake_address,
            timestamp: wallet.timestamp,
            walletType: wallet.walletType,
            // Only store essential asset data
            assets: wallet.assets ? wallet.assets.map(asset => ({
              unit: asset.unit,
              quantity: asset.quantity,
              decimals: asset.decimals,
              readable_amount: asset.readable_amount,
              display_name: asset.display_name,
              ticker: asset.ticker
            })) : []
          };

          chrome.storage.sync.set({ 
            [`wallet_${wallet.address}`]: cleanWallet 
          }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            resolve();
          });
        })
      );

      // Save the index and wait for all wallet saves
      Promise.all([
        new Promise((resolve, reject) => {
          chrome.storage.sync.set({ 
            wallet_index: walletIndex,
            unlockedSlots 
          }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            resolve();
          });
        }),
        ...savePromises
      ]).then(() => resolve()).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

// UI Functions
function showError(message) {
  const errorDiv = document.getElementById('errorMsg');
  if (errorDiv) {
    // Remove any existing visible messages
    const visibleMessages = document.querySelectorAll('.error.visible, .success.visible');
    visibleMessages.forEach(msg => msg.classList.remove('visible'));
    
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Force a reflow before adding the visible class
    errorDiv.offsetHeight;
    errorDiv.classList.add('visible');
    
    setTimeout(() => {
      errorDiv.classList.remove('visible');
      setTimeout(() => {
        errorDiv.style.display = 'none';
      }, 300); // Wait for transition to finish
    }, 3000);
  }
}

function showSuccess(message) {
  const successDiv = document.getElementById('successMsg');
  if (successDiv) {
    // Remove any existing visible messages
    const visibleMessages = document.querySelectorAll('.error.visible, .success.visible');
    visibleMessages.forEach(msg => msg.classList.remove('visible'));
    
    successDiv.textContent = message;
    successDiv.style.display = 'block';
    
    // Force a reflow before adding the visible class
    successDiv.offsetHeight;
    successDiv.classList.add('visible');
    
    setTimeout(() => {
      successDiv.classList.remove('visible');
      setTimeout(() => {
        successDiv.style.display = 'none';
      }, 300); // Wait for transition to finish
    }, 3000);
  }
}

function validateAddress(address) {
  return address && address.startsWith('addr1') && address.length >= 59;
}

async function addWallet() {
  const addressInput = document.getElementById('addressInput');
  const nameInput = document.getElementById('nameInput');
  const walletTypeSelect = document.getElementById('walletType');
  
  const address = addressInput?.value?.trim();
  const name = nameInput?.value?.trim();
  const walletType = walletTypeSelect?.value;

  try {
    if (!address) {
      throw new Error('Please enter a wallet address');
    }
    if (!name) {
      throw new Error('Please enter a wallet name');
    }
    if (wallets.length >= unlockedSlots) {
      throw new Error('No available slots. Please unlock more slots.');
    }
    if (wallets.some(w => w.address === address)) {
      throw new Error('This wallet address is already in your address book');
    }

    showSuccess('Adding wallet...');
    const walletData = await fetchWalletData(address);
    
    // Store only essential wallet data
    const wallet = {
      address,
      name,
      walletType,
      balance: walletData.balance,
      stake_address: walletData.stake_address,
      timestamp: Date.now(),
      // Only store minimal asset data
      assets: walletData.assets ? walletData.assets.map(asset => ({
        unit: asset.unit,
        quantity: asset.quantity,
        decimals: asset.decimals,
        readable_amount: asset.readable_amount,
        display_name: asset.display_name,
        ticker: asset.ticker
      })) : []
    };

    wallets.push(wallet);
    await saveWallets();
    
    // Clear inputs
    addressInput.value = '';
    nameInput.value = '';
    walletTypeSelect.value = 'None';
    
    showSuccess('Wallet added successfully!');
  } catch (error) {
    console.error('Failed to add wallet:', error);
    showError(error.message || 'Failed to add wallet');
  }
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
      <p class="address">Address: ${wallet.address}</p>
      <p class="balance">Balance: ${(parseInt(wallet.balance) / 1000000).toFixed(2)} ₳</p>
      ${wallet.stake_address ? 
        `<p class="stake">Stake Address: ${wallet.stake_address}</p>` : 
        ''}
      ${wallet.assets && wallet.assets.length > 0 ? `
        <div class="assets">
          <p class="assets-title">Assets:</p>
          <div class="assets-list">
            ${wallet.assets.map(asset => `
              <div class="asset-item" title="${asset.unit}">
                <span class="asset-quantity">${asset.quantity !== 1 ? `${asset.quantity}x` : ''}</span>
                <span class="asset-name">${
                  asset.display_name || 
                  asset.asset_name || 
                  (asset.unit.length > 20 ? asset.unit.substring(0, 20) + '...' : asset.unit)
                }</span>
                ${asset.onchain_metadata?.image ? 
                  `<img src="${convertIpfsUrl(asset.onchain_metadata.image)}" alt="${asset.display_name || 'Asset'}" class="asset-image">` : 
                  ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <p class="timestamp">Added: ${new Date(wallet.timestamp).toLocaleString()}</p>
    </div>
  `).join('');
}

function renderWalletSelector() {
  return Object.entries(WALLET_LOGOS).map(([name, logo]) => `
    <option value="${name}" ${name === 'None' ? 'selected' : ''}>
      ${name}
    </option>
  `).join('');
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

async function refreshWallet(index) {
  try {
    const wallet = wallets[index];
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    showSuccess('Refreshing wallet data...');
    const walletData = await fetchWalletData(wallet.address);
    
    console.log('Wallet data received:', walletData);
    if (walletData.assets) {
      console.log('Assets:', walletData.assets.map(asset => ({
        unit: asset.unit,
        metadata: asset.onchain_metadata,
        image: asset.onchain_metadata?.image
      })));
    }
    
    wallet.balance = walletData.balance;
    wallet.assets = walletData.assets;
    wallet.timestamp = Date.now();
    
    await saveWallets();
    updateUI();
    showSuccess('Wallet data updated!');
  } catch (error) {
    console.error('Error refreshing wallet:', error);
    showError(error.message || 'Failed to refresh wallet');
  }
}

function updateUI() {
  const slotsDisplay = document.getElementById('availableSlots');
  if (slotsDisplay) {
    slotsDisplay.textContent = `${wallets.length} / ${unlockedSlots}`;
  }

  const addWalletBtn = document.getElementById('addWallet');
  if (addWalletBtn) {
    addWalletBtn.disabled = wallets.length >= unlockedSlots;
  }

  const walletTypeSelect = document.getElementById('walletType');
  if (walletTypeSelect) {
    walletTypeSelect.innerHTML = renderWalletSelector();
  }
}

async function checkPaymentStatus() {
  try {
    if (!currentPaymentId) {
      showError('No active payment request found. Please try again.');
      return;
    }

    const result = await verifyPayment(currentPaymentId);
    
    if (result.verified) {
      // Update unlocked slots
      unlockedSlots += SLOTS_PER_PAYMENT;
      
      // Save to storage
      await chrome.storage.sync.set({ unlockedSlots });
      
      // Update UI
      updateUI();
      
      showSuccess(`Payment verified! You now have ${SLOTS_PER_PAYMENT} more wallet slots available.`);
      
      // Close payment instructions if open
      const instructions = document.querySelector('.modal');
      if (instructions) {
        instructions.remove();
      }

      // Reset payment ID
      currentPaymentId = null;
    } else {
      showError('Payment not yet verified. Please make sure you sent the exact amount and try verifying again.');
    }
  } catch (error) {
    console.error('Error checking payment:', error);
    showError('Failed to verify payment. Please try again.');
  }
}

function setupEventListeners() {
  const addWalletBtn = document.getElementById('addWallet');
  if (addWalletBtn) {
    addWalletBtn.addEventListener('click', addWallet);
  }

  const openFullviewBtn = document.getElementById('openFullview');
  if (openFullviewBtn) {
    openFullviewBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('fullview.html') });
    });
  }

  const unlockButton = document.getElementById('unlockButton');
  if (unlockButton) {
    unlockButton.addEventListener('click', async () => {
      try {
        // Request new payment with random amount
        const paymentRequest = await requestPayment();
        currentPaymentId = paymentRequest.paymentId;

        const instructions = document.createElement('div');
        instructions.innerHTML = `
          <div class="modal">
            <h3>Unlock More Slots</h3>
            <p class="important">Send EXACTLY ${paymentRequest.amount} ₳</p>
            <p class="warning">The amount must be exact for verification!</p>
            <code>${paymentRequest.address}</code>
            <p>You will receive ${SLOTS_PER_PAYMENT} additional wallet slots after payment confirmation.</p>
            <button class="verify-payment">Check Payment Status</button>
            <button class="close">Close</button>
          </div>
        `;
        document.body.appendChild(instructions);

        // Add event listeners for the new buttons
        const verifyBtn = instructions.querySelector('.verify-payment');
        const closeBtn = instructions.querySelector('.close');
        
        if (verifyBtn) {
          verifyBtn.addEventListener('click', checkPaymentStatus);
        }
        
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            instructions.remove();
            currentPaymentId = null; // Reset payment ID when modal is closed
          });
        }
      } catch (error) {
        console.error('Error setting up payment:', error);
        showError('Failed to generate payment request. Please try again.');
      }
    });
  }

  const deleteButtons = document.querySelectorAll('.delete-btn');
  deleteButtons.forEach(button => {
    const index = button.dataset.index;
    if (index !== undefined) {
      button.addEventListener('click', () => deleteWallet(parseInt(index)));
    }
  });

  const refreshButtons = document.querySelectorAll('.refresh-btn');
  refreshButtons.forEach(button => {
    const index = button.dataset.index;
    if (index !== undefined) {
      button.addEventListener('click', () => refreshWallet(parseInt(index)));
    }
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Reset storage to ensure we're using the new default slots
    const data = await chrome.storage.sync.get(['wallets', 'unlockedSlots']);
    if (!data.unlockedSlots || data.unlockedSlots === 5) {
      await chrome.storage.sync.set({
        wallets: data.wallets || [],
        unlockedSlots: MAX_FREE_SLOTS
      });
    }
    
    await loadWallets();
    updateUI();
    setupEventListeners();
  } catch (error) {
    console.error('Error initializing popup:', error);
    showError('Failed to initialize. Please try again.');
  }
});
