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
    const data = await chrome.storage.sync.get(['wallets', 'unlockedSlots']);
    wallets = data.wallets || [];
    unlockedSlots = data.unlockedSlots || MAX_FREE_SLOTS;
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
  }
}

async function saveWallets() {
  try {
    await chrome.storage.sync.set({ wallets, unlockedSlots });
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
  
  // Check onchain_metadata first
  if (asset.onchain_metadata?.image) {
    return convertIpfsUrl(asset.onchain_metadata.image);
  }
  
  // Check metadata
  if (asset.metadata?.image || asset.metadata?.logo) {
    return convertIpfsUrl(asset.metadata.image || asset.metadata.logo);
  }

  // Check files array if present
  if (asset.metadata?.files && asset.metadata.files.length > 0) {
    const file = asset.metadata.files[0];
    if (typeof file === 'string') {
      return convertIpfsUrl(file);
    }
    if (file.src || file.uri) {
      return convertIpfsUrl(file.src || file.uri);
    }
  }

  return null;
}

function isNFT(asset) {
  // Rule 1: If quantity > 1, it's a token
  const quantity = parseInt(asset.quantity);
  if (!isNaN(quantity) && quantity > 1) {
    return false;
  }

  // Rule 2: Check onchain_metadata for NFT properties
  if (asset.onchain_metadata) {
    // Check for media properties
    if (asset.onchain_metadata.image || 
        asset.onchain_metadata.mediaType || 
        asset.onchain_metadata.files) {
      return true;
    }
    
    // Check for NFT collection properties
    if (asset.onchain_metadata.name && 
        (asset.onchain_metadata.series || 
         asset.onchain_metadata.edition || 
         asset.onchain_metadata.collection)) {
      return true;
    }
  }

  // Rule 3: Check regular metadata
  if (asset.metadata) {
    if (asset.metadata.image || asset.metadata.files) {
      return true;
    }
  }

  // Rule 4: Check name patterns
  const name = asset.display_name || asset.asset_name || '';
  if (/#\d+$/.test(name) ||           // Ends with #123
      /\(\d+(?:\/\d+)?\)$/.test(name) // Ends with (123) or (123/456)
  ) {
    return true;
  }

  // If none of the above rules match, consider it a token
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
          
          <div class="address-row">
            <span class="label">Stake</span>
            <div class="address-value" role="button" tabindex="0" data-copy="${wallet.stake_address}">
              <span class="stake">${truncateAddress(wallet.stake_address)}</span>
              <span class="copy-indicator">Copy</span>
            </div>
          </div>
        </div>

        <div class="wallet-footer">
          <div class="balance-group">
            <span class="balance">${formatBalance(wallet.balance)} ₳</span>
            <button class="refresh-btn" data-index="${index}" title="Refresh">↻</button>
          </div>
          ${wallet.assets && wallet.assets.length > 0 ? `
            <button class="assets-btn" data-index="${index}">
              ${wallet.assets.length} Assets
            </button>
          ` : ''}
        </div>
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

function renderAssetsList(walletIndex, type = 'nfts') {
  const wallet = wallets[walletIndex];
  const assetsList = document.querySelector('.assets-list');
  
  if (!assetsList) return; // Early return if element doesn't exist
  if (!wallet || !wallet.assets) return;

  // Filter and sort assets
  const filteredAssets = wallet.assets.filter(asset => {
    const isNftAsset = isNFT(asset);
    return type === 'nfts' ? isNftAsset : !isNftAsset;
  });

  if (filteredAssets.length === 0) {
    assetsList.innerHTML = `<p class="no-assets">No ${type === 'nfts' ? 'NFTs' : 'tokens'} found</p>`;
    return;
  }

  assetsList.innerHTML = filteredAssets.map(asset => {
    const assetName = asset.display_name || asset.asset_name || '';
    const firstLetter = getFirstLetter(assetName);
    const bgColor = getRandomColor(assetName);
    const imageUrl = getAssetImage(asset);
    const quantity = formatTokenAmount(asset.quantity, asset.metadata?.decimals || asset.onchain_metadata?.decimals || 0);

    return `
      <div class="asset-item">
        <div class="asset-image-container">
          ${imageUrl ? `
            <img src="${imageUrl}" 
                 alt="${assetName}" 
                 class="asset-image"
                 data-fallback="${firstLetter}"
                 data-bgcolor="${bgColor}">
          ` : `
            <div class="asset-placeholder full" style="background-color: ${bgColor}">
              ${firstLetter}
            </div>
          `}
        </div>
        <div class="asset-info">
          <span class="asset-name">${assetName}</span>
          <span class="asset-quantity">${isNFT(asset) ? '' : `${quantity}x`}</span>
        </div>
      </div>
    `;
  }).join('');

  // Add error handlers for images after rendering
  assetsList.querySelectorAll('.asset-image').forEach(img => {
    img.addEventListener('error', function() {
      const firstLetter = this.getAttribute('data-fallback');
      const bgColor = this.getAttribute('data-bgcolor');
      this.parentElement.innerHTML = `<div class="asset-placeholder full" style="background-color: ${bgColor}">${firstLetter}</div>`;
    });
  });
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
  if (!balance) return '0.00';
  return (balance / 1000000).toFixed(2);
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
            <span class="label">Amount:</span>
            <span class="value">${amount} ADA</span>
          </div>
          
          <div class="address-container">
            <span class="label">Send to this address:</span>
            <div class="address-box">
              <span class="address">${address}</span>
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
      await navigator.clipboard.writeText(address);
      showSuccess('Address copied to clipboard!');
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    updateUI();
    setupEventListeners();
    setupAssetsPanelListeners();

    // Listen for storage changes to auto-refresh
    chrome.storage.onChanged.addListener(async (changes, namespace) => {
      if (namespace === 'sync' && changes.wallets) {
        console.log('Wallet data changed, refreshing...');
        await loadWallets();
        updateUI();
      }
    });
  } catch (error) {
    console.error('Error initializing:', error);
    showError('Failed to initialize the wallet address book');
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
