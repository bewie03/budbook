// Import the shared constants and functions
const MAX_FREE_SLOTS = 6;
const SLOTS_PER_PAYMENT = 6;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 2;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

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

let wallets = [];
let unlockedSlots = MAX_FREE_SLOTS;

// Cache management
const ASSET_CACHE_KEY = 'walletpup_asset_cache';

async function getAssetCache() {
  try {
    const cache = await chrome.storage.sync.get(ASSET_CACHE_KEY);
    return cache[ASSET_CACHE_KEY] || {};
  } catch (error) {
    console.error('Error reading asset cache:', error);
    return {};
  }
}

async function setAssetCache(assetId, data) {
  try {
    const cache = await getAssetCache();
    cache[assetId] = {
      data,
      timestamp: Date.now() // Keep timestamp for debugging purposes
    };
    await chrome.storage.sync.set({ [ASSET_CACHE_KEY]: cache });
  } catch (error) {
    console.error('Error writing to asset cache:', error);
  }
}

async function getAssetFromCache(assetId) {
  try {
    const cache = await getAssetCache();
    const cachedAsset = cache[assetId];
    
    if (cachedAsset) {
      return cachedAsset.data;
    }
    return null;
  } catch (error) {
    console.error('Error reading from asset cache:', error);
    return null;
  }
}

async function loadWallets() {
  try {
    // Load wallet index and slots from sync storage
    const data = await chrome.storage.sync.get(['wallet_index', 'unlockedSlots']);
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

    console.log('Loaded wallets:', wallets);
    updateUI();
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
  }
}

async function saveWallets() {
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
    await Promise.all([
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
    ]);
  } catch (error) {
    console.error('Error saving wallets:', error);
    showError('Failed to save wallet changes');
  }
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

function getAssetImage(asset) {
  if (!asset) return null;
  
  try {
    // Check onchain_metadata first
    if (asset.onchain_metadata?.image) {
      const image = asset.onchain_metadata.image;
      return typeof image === 'string' ? convertIpfsUrl(image) : null;
    }
    
    // Check metadata
    if (asset.metadata?.image || asset.metadata?.logo) {
      const image = asset.metadata.image || asset.metadata.logo;
      return typeof image === 'string' ? convertIpfsUrl(image) : null;
    }

    // Check files array if present
    if (asset.metadata?.files && Array.isArray(asset.metadata.files) && asset.metadata.files.length > 0) {
      const file = asset.metadata.files[0];
      if (typeof file === 'string') {
        return convertIpfsUrl(file);
      }
      if (file && typeof file === 'object') {
        const fileUrl = file.src || file.uri || file.url || file.image;
        return typeof fileUrl === 'string' ? convertIpfsUrl(fileUrl) : null;
      }
    }

    return null;
  } catch (error) {
    console.error('Error getting asset image:', error, 'Asset:', asset);
    return null;
  }
}

function isNFT(asset) {
  // Rule 1: If quantity > 1, it's a token
  const quantity = BigInt(asset.quantity);
  if (quantity > BigInt(1)) {
    return false;
  }

  // Rule 2: Check if it has an image
  if (asset.image_url) {
    return true;
  }

  // Rule 3: Check metadata for NFT properties
  if (asset.onchain_metadata) {
    // Check for media properties
    if (asset.onchain_metadata.image || 
        asset.onchain_metadata.mediaType || 
        asset.onchain_metadata.files) {
      return true;
    }
    
    // Check for common NFT attributes
    if (asset.onchain_metadata.attributes || 
        asset.onchain_metadata.traits) {
      return true;
    }
  }

  return false;
}

function convertIpfsUrl(url) {
  // Return null for invalid inputs
  if (!url || typeof url !== 'string') return null;

  // Handle ipfs:// protocol
  if (url.startsWith('ipfs://')) {
    const ipfsId = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${ipfsId}`;
  }

  // Handle IPFS paths
  if (url.startsWith('/ipfs/')) {
    return `https://ipfs.io${url}`;
  }

  // Handle direct IPFS hashes
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44,}/.test(url)) {
    return `https://ipfs.io/ipfs/${url}`;
  }

  // Handle URLs that are already using an IPFS gateway
  if (url.includes('ipfs.io') || url.includes('cloudflare-ipfs.com')) {
    return url;
  }

  // Handle base64 images
  if (url.startsWith('data:image/')) {
    return url;
  }

  // Handle regular HTTP(S) URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // If we can't handle the URL format, return null
  return null;
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
  if (!wallets || wallets.length === 0) {
    return '<p class="no-wallets">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => `
    <div class="wallet-item">
      <div class="wallet-top">
        ${wallet.walletType !== 'None' && WALLET_LOGOS[wallet.walletType] ? 
          `<img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}" class="wallet-logo">` : 
          ''}
        <h3>${wallet.name}</h3>
        <button class="delete-btn" data-index="${index}" title="Delete">×</button>
      </div>

      <div class="wallet-content">
        <div class="wallet-addresses">
          <div class="address-row">
            <span class="label">Address</span>
            <div class="address-value" role="button" tabindex="0" data-copy="${wallet.address}">
              <span class="address">${truncateAddress(wallet.address)}</span>
              <span class="copy-indicator">Copy</span>
            </div>
          </div>
          
          ${wallet.stake_address ? `
            <div class="address-row">
              <span class="label">Stake</span>
              <div class="address-value" role="button" tabindex="0" data-copy="${wallet.stake_address}">
                <span class="stake">${truncateAddress(wallet.stake_address)}</span>
                <span class="copy-indicator">Copy</span>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="wallet-footer">
          <div class="balance-group">
            <span class="balance">${formatBalance(wallet.balance)} ₳</span>
            <button class="refresh-btn" data-index="${index}" title="Refresh">↻</button>
          </div>
          ${wallet.assets && wallet.assets.length > 0 ? `
            <button class="assets-btn" data-index="${index}">
              ${wallet.assets.length} Token${wallet.assets.length === 1 ? '' : 's'}
            </button>
          ` : ''}
        </div>

        ${wallet.assets && wallet.assets.length > 0 ? `
          <div class="assets-preview">
            ${wallet.assets.slice(0, 3).map(asset => `
              <div class="asset-preview-item" title="${asset.display_name}">
                ${asset.onchain_metadata?.image ? 
                  `<img src="${convertIpfsUrl(asset.onchain_metadata.image)}" alt="${asset.display_name}" class="asset-image">` :
                  `<div class="asset-placeholder">${getFirstLetter(asset.display_name)}</div>`
                }
                <div class="asset-info">
                  <span class="asset-name">${asset.display_name}</span>
                  <span class="asset-amount">${asset.readable_amount}</span>
                </div>
              </div>
            `).join('')}
            ${wallet.assets.length > 3 ? `
              <div class="asset-preview-more">
                +${wallet.assets.length - 3} more
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function setupAssetsPanelListeners() {
  const panel = document.querySelector('.assets-panel');
  if (!panel) return; // Exit if panel doesn't exist

  const closeBtn = panel.querySelector('.close-assets');
  const tabs = panel.querySelectorAll('.assets-tab');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.classList.remove('expanded');
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const currentWallet = panel.dataset.walletIndex;
      const tabType = tab.dataset.tab;
      
      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Render assets for the selected tab
      renderAssetsList(currentWallet, tabType);
    });
  });
}

function getFirstLetter(name) {
  return (name || 'A').charAt(0).toUpperCase();
}

function getRandomColor(text) {
  // Generate a consistent color based on text
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 60%)`; // Consistent but random-looking color
}

function renderAssetsList(walletIndex, type = 'tokens') {
  const wallet = wallets[walletIndex];
  if (!wallet?.assets) return '';

  const isNFTList = type === 'nfts';
  const assets = wallet.assets.filter(asset => isNFTList ? isNFT(asset) : !isNFT(asset));

  return assets.map(asset => `
    <div class="asset-item">
      ${asset.image_url ? `
        <div class="asset-image">
          <img src="${asset.image_url}" alt="${asset.display_name}" onerror="this.style.display='none'">
        </div>
      ` : ''}
      <div class="asset-info">
        <h4>${asset.display_name}</h4>
        <p class="asset-amount">${asset.readable_amount} ${asset.ticker || ''}</p>
        ${!isNFTList ? `<p class="asset-policy">Policy: ${asset.unit.substring(0, 56)}</p>` : ''}
      </div>
    </div>
  `).join('') || `<p class="no-assets">No ${isNFTList ? 'NFTs' : 'tokens'} found</p>`;
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

  // Add assets toggle listeners
  document.querySelectorAll('.assets-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const index = button.dataset.index;
      const panel = document.querySelector('.assets-panel');
      
      // If panel is already showing this wallet's assets, close it
      if (panel.classList.contains('expanded') && panel.dataset.walletIndex === index) {
        panel.classList.remove('expanded');
        return;
      }
      
      // Otherwise, show the panel with this wallet's assets
      panel.dataset.walletIndex = index;
      panel.classList.add('expanded');
      
      // Show NFTs by default
      const nftsTab = panel.querySelector('[data-tab="nfts"]');
      nftsTab.click();
    });
  });

  setupAssetsPanelListeners();
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

function formatBalance(balance) {
  if (!balance) return '0';
  return parseFloat(balance).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  }) + ' ₳';
}

function formatTokenAmount(amount, decimals = 0) {
  if (!amount) return '0';
  
  // Convert to number and handle decimals
  const num = BigInt(amount);
  if (decimals > 0) {
    const divisor = BigInt(10 ** decimals);
    const wholePart = num / divisor;
    const fractionalPart = num % divisor;
    
    // Convert to string with proper decimal places
    let formatted = wholePart.toString();
    if (fractionalPart > 0) {
      // Pad with leading zeros if needed
      let fraction = fractionalPart.toString().padStart(decimals, '0');
      // Remove trailing zeros
      fraction = fraction.replace(/0+$/, '');
      if (fraction.length > 0) {
        formatted += '.' + fraction;
      }
    }
    return formatted;
  }
  
  // For non-decimal numbers, just add commas
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

// Buy slots button handler
document.getElementById('buySlots').addEventListener('click', async () => {
  try {
    // Get current slot count
    const { availableSlots } = await chrome.storage.local.get('availableSlots');
    const currentSlots = availableSlots || 3;
    
    // Show payment modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content payment-modal">
        <div class="modal-header">
          <h2>Buy Additional Wallet Slots</h2>
          <div class="slot-info">
            <span>Current slots: ${currentSlots}</span>
            <span class="price-tag">Price: 2-3 ADA per slot</span>
          </div>
        </div>

        <div class="payment-steps">
          <div class="step">
            <div class="step-number">1</div>
            <div class="step-text">Send the required ADA to the verification address</div>
          </div>
          <div class="step">
            <div class="step-number">2</div>
            <div class="step-text">Wait for transaction confirmation</div>
          </div>
          <div class="step">
            <div class="step-number">3</div>
            <div class="step-text">Your slots will be automatically added</div>
          </div>
        </div>

        <div class="button-container">
          <button class="modal-button cancel">Cancel</button>
          <button class="modal-button proceed">Proceed</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Handle modal buttons
    modal.querySelector('.cancel').addEventListener('click', () => {
      modal.remove();
    });
    
    modal.querySelector('.proceed').addEventListener('click', async () => {
      modal.remove();
      await initiatePayment();
    });
    
  } catch (error) {
    console.error('Error handling buy slots:', error);
    showError('Failed to process slot purchase. Please try again.');
  }
});

async function initiatePayment() {
  try {
    // Get extension's installation ID
    const installId = chrome.runtime.id;
    
    // Get payment details from server
    const response = await fetch('https://budbook-2410440cbb61.herokuapp.com/api/initiate-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        installId
      })
    });

    if (!response.ok) throw new Error('Failed to initiate payment');
    const { paymentId, amount, address } = await response.json();
    
    // Show payment details modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content payment-modal">
        <div class="modal-header">
          <h2>Payment Details</h2>
        </div>
        
        <div class="payment-details">
          <div class="amount-display">
            <span class="label">AMOUNT:</span>
            <span class="value">${parseFloat(amount).toFixed(6)} ADA</span>
          </div>
          
          <div class="address-container">
            <span class="label">SEND TO THIS ADDRESS:</span>
            <div class="address-box">
              <span class="address" title="${address}">${truncateAddress(address, 12, 8)}</span>
              <button class="copy-button" data-address="${address}">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          </div>
          
          <div class="payment-note">
            Payment will be verified automatically once confirmed on the blockchain. 
            This payment is linked to your extension installation and can only be used once.
          </div>
        </div>

        <div class="button-container">
          <button class="modal-button cancel">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Handle copy button
    modal.querySelector('.copy-button').addEventListener('click', async (e) => {
      const address = e.currentTarget.dataset.address;
      if (address) {
        await copyToClipboard(address);
        showSuccess('Address copied to clipboard!');
      }
    });
    
    // Handle close button
    modal.querySelector('.cancel').addEventListener('click', () => {
      modal.remove();
    });
    
    // Start polling for payment verification
    let attempts = 0;
    const maxAttempts = 180; // 3 minutes
    const pollInterval = setInterval(async () => {
      try {
        const verifyResponse = await fetch(`https://budbook-2410440cbb61.herokuapp.com/api/verify-payment/${paymentId}`);
        if (!verifyResponse.ok) throw new Error('Failed to verify payment');
        const { verified, used } = await verifyResponse.json();
        
        if (verified) {
          clearInterval(pollInterval);
          modal.remove();
          
          if (used) {
            showError('This payment has already been used to add slots.');
            return;
          }
          
          showSuccess('Payment verified! Your slots have been added.');
          // Refresh available slots
          const { availableSlots } = await chrome.storage.local.get('availableSlots');
          await chrome.storage.local.set({ 
            availableSlots: (availableSlots || 3) + 1 
          });
          // Update UI
          updateSlotDisplay();
        }
        
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          showError('Payment verification timed out. Please contact support if payment was sent.');
        }
      } catch (error) {
        console.error('Error verifying payment:', error);
      }
    }, 1000);
    
  } catch (error) {
    console.error('Error initiating payment:', error);
    showError('Failed to initiate payment. Please try again.');
  }
}

async function fetchWalletData(address) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/wallet/${address}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    
    // Store only essential data
    return {
      address: data.address,
      stake_address: data.stake_address,
      balance: data.balance,
      assets: data.assets?.map(asset => ({
        unit: asset.unit,
        quantity: asset.quantity,
        decimals: asset.decimals,
        readable_amount: asset.readable_amount,
        display_name: asset.display_name,
        ticker: asset.ticker
      })) || []
    };
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

// Listen for reload messages from background script
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'RELOAD_WALLETS') {
    console.log('Reloading wallets due to storage change');
    await loadWallets();
    updateUI();
  }
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    updateUI();
    setupEventListeners();
    setupAssetsPanelListeners();
  } catch (error) {
    console.error('Error initializing fullview:', error);
    showError('Failed to initialize. Please try again.');
  }
});

document.addEventListener('click', function(e) {
  const addressValue = e.target.closest('.address-value');
  if (addressValue) {
    const textToCopy = addressValue.dataset.copy;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        // Show feedback
        const indicator = addressValue.querySelector('.copy-indicator');
        indicator.textContent = 'Copied!';
        setTimeout(() => {
          indicator.textContent = 'Copy';
        }, 1000);
      });
    }
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ' ') {
    const addressValue = e.target.closest('.address-value');
    if (addressValue) {
      e.preventDefault();
      addressValue.click();
    }
  }
});
