// Constants
const MAX_FREE_SLOTS = 6;
const SLOTS_PER_PAYMENT = 6;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 2;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';
const MAX_STORED_ASSETS = 5; // Store only top 5 assets by value
const ADA_LOVELACE = 1000000; // 1 ADA = 1,000,000 Lovelace

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
      // Load wallet index and slots from sync storage
      chrome.storage.sync.get(['wallet_index', 'unlockedSlots'], async (data) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        
        const walletIndex = data.wallet_index || [];
        unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;

        // Load wallet metadata from sync storage
        const walletPromises = walletIndex.map(address => 
          new Promise((resolve) => {
            chrome.storage.sync.get(`wallet_${address}`, (result) => {
              resolve(result[`wallet_${address}`]);
            });
          })
        );

        // Load assets from local storage
        const assetPromises = walletIndex.map(address => 
          new Promise((resolve) => {
            chrome.storage.local.get(`assets_${address}`, (result) => {
              resolve(result[`assets_${address}`]);
            });
          })
        );

        // Wait for all data to load
        const [walletData, assetData] = await Promise.all([
          Promise.all(walletPromises),
          Promise.all(assetPromises)
        ]);

        // Combine wallet data with assets
        wallets = walletData.map((wallet, index) => ({
          ...wallet,
          assets: assetData[index] || []
        })).filter(Boolean);

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
      const syncPromises = wallets.map(wallet => 
        new Promise((resolve, reject) => {
          // Store minimal wallet data in sync storage
          const syncData = {
            address: wallet.address,
            name: wallet.name,
            balance: wallet.balance,
            stake_address: wallet.stake_address,
            timestamp: wallet.timestamp,
            walletType: wallet.walletType
          };

          chrome.storage.sync.set({ 
            [`wallet_${wallet.address}`]: syncData 
          }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            resolve();
          });
        })
      );

      // Store assets in local storage
      const localPromises = wallets.map(wallet => 
        new Promise((resolve, reject) => {
          chrome.storage.local.set({ 
            [`assets_${wallet.address}`]: wallet.assets 
          }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            resolve();
          });
        })
      );

      // Save the index and wait for all saves
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
        ...syncPromises,
        ...localPromises
      ]).then(() => resolve()).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
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
    console.log('Fetching wallet data for:', address);
    const walletData = await fetchWalletData(address);
    console.log('Received wallet data:', {
      hasBalance: !!walletData.balance,
      numAssets: walletData.assets?.length
    });
    
    // Store wallet data
    const wallet = {
      address,
      name,
      walletType,
      balance: walletData.balance || '0',
      stake_address: walletData.stake_address || '',
      timestamp: Date.now(),
      // Store all assets
      assets: (walletData.assets || []).map(asset => ({
        unit: asset.unit,
        quantity: asset.quantity,
        decimals: asset.decimals,
        display_name: asset.display_name,
        ticker: asset.ticker,
        readable_amount: asset.readable_amount
      }))
    };

    console.log('Processed wallet data:', {
      dataSize: JSON.stringify(wallet).length,
      numAssets: wallet.assets.length
    });

    // Add to wallets array
    wallets.push(wallet);
    
    try {
      await saveWallets();
      
      // Clear inputs
      addressInput.value = '';
      nameInput.value = '';
      walletTypeSelect.value = 'None';
      
      showSuccess('Wallet added successfully!');
      
      // Notify background script that a wallet was added
      chrome.runtime.sendMessage({ type: 'WALLET_ADDED' });
    } catch (storageError) {
      // Remove from array if save failed
      wallets.pop();
      throw new Error(`Failed to save wallet: ${storageError.message}`);
    }
  } catch (error) {
    console.error('Failed to add wallet:', error);
    showError(error.message || 'Failed to add wallet. Please try again.');
  }
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

function formatBalance(balance) {
  if (!balance) return '0';
  return parseFloat(balance).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  }) + ' ₳';
}

function renderWallets() {
  if (!wallets.length) {
    return '<p class="no-wallets">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => `
    <div class="wallet-item">
      <div class="wallet-header">
        <h3>${wallet.name}</h3>
      </div>
      <p class="address">Address: ${wallet.address}</p>
      <p class="balance">Balance: ${wallet.balance} ₳</p>
      ${wallet.stake_address ? 
        `<p class="stake">Stake Address: ${wallet.stake_address}</p>` : 
        ''}
      ${wallet.assets?.length ? 
        `<p class="assets-count">Assets: ${wallet.assets.length}</p>` : 
        ''}
      <div class="wallet-actions">
        <button class="refresh-btn" data-index="${index}">
          <i class="fas fa-sync-alt"></i>
        </button>
        <button class="delete-btn" data-index="${index}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
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

  // Render wallet list
  const walletList = document.getElementById('walletList');
  if (walletList) {
    walletList.innerHTML = renderWallets();
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
      chrome.tabs.create({
        url: chrome.runtime.getURL('fullview.html')
      });
      window.close(); // Close the popup
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

// Helper to sort assets by ADA value
function sortAssetsByValue(assets) {
  return assets.sort((a, b) => {
    const aQuantity = BigInt(a.quantity || '0');
    const bQuantity = BigInt(b.quantity || '0');
    return bQuantity > aQuantity ? 1 : -1;
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    updateUI();
    setupEventListeners();

    // Handle Open Address Book button
    document.getElementById('openFullview').addEventListener('click', () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL('fullview.html')
      });
      window.close();
    });
  } catch (error) {
    console.error('Error initializing popup:', error);
    showError('Failed to initialize. Please try again.');
  }
});
