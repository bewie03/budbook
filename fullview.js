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
    
    // Save wallet index and unlocked slots to sync storage
    await chrome.storage.sync.set({
      wallet_index: walletIndex,
      unlockedSlots: unlockedSlots
    });

    // Save individual wallet metadata to sync storage
    const walletPromises = wallets.map(wallet => {
      const { address, name, walletType, stake_address, timestamp } = wallet;
      return chrome.storage.sync.set({
        [`wallet_${address}`]: { address, name, walletType, stake_address, timestamp }
      });
    });

    // Save assets to local storage (they can be large)
    const assetPromises = wallets.map(wallet => {
      const { address, assets, balance } = wallet;
      return chrome.storage.local.set({
        [`assets_${address}`]: assets,
        [`balance_${address}`]: balance
      });
    });

    // Wait for all storage operations to complete
    await Promise.all([...walletPromises, ...assetPromises]);
    
    console.log('Wallets saved successfully:', wallets);
  } catch (error) {
    console.error('Error saving wallets:', error);
    throw error;
  }
}

async function showError(message) {
  const errorDiv = document.getElementById('errorMsg');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.classList.add('visible');
    setTimeout(() => {
      errorDiv.classList.remove('visible');
    }, 3000);
  }
}

async function showSuccess(message) {
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
  // Try to get image from metadata first
  if (asset.metadata?.image) {
    return convertIpfsUrl(asset.metadata.image);
  }
  // Fallback to direct image property
  return asset.image ? convertIpfsUrl(asset.image) : null;
}

function isNFT(asset) {
  if (!asset) return false;
  // Check multiple conditions that could indicate an NFT
  return asset.is_nft || 
         asset.quantity === '1' || 
         asset.onchainMetadata?.type === 'NFT' ||
         (asset.metadata && Object.keys(asset.metadata).length > 0 && asset.quantity === '1');
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
    <div class="wallet-item" data-wallet-index="${index}">
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
            <span class="balance">${formatBalance(wallet.balance)}</span>
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

  return assets.map(asset => {
    // Get image URL from metadata or direct property
    const imageUrl = getAssetImage(asset);
    
    // Get display name from metadata or fallback to unit
    const displayName = asset.name || asset.unit.slice(-8);
    
    const displayAmount = formatTokenAmount(asset.quantity, asset.decimals) + (asset.ticker ? ` ${asset.ticker}` : '');
    
    return `
      <div class="asset-item">
        ${imageUrl ? `
          <div class="asset-image">
            <img src="${imageUrl}" alt="${displayName}" onerror="this.onerror=null; this.style.display='none'; this.parentElement.innerHTML='<span>${getFirstLetter(displayName)}</span>';">
          </div>
        ` : `
          <div class="asset-image asset-placeholder" style="background-color: ${getRandomColor(displayName)}">
            <span>${getFirstLetter(displayName)}</span>
          </div>
        `}
        <div class="asset-info">
          <h4>${displayName}</h4>
          <p class="asset-amount">${displayAmount}</p>
          ${!isNFTList ? `<p class="asset-policy">Policy: ${asset.unit.substring(0, 56)}</p>` : ''}
        </div>
      </div>
    `;
  }).join('') || `<p class="no-assets">No ${isNFTList ? 'NFTs' : 'tokens'} found</p>`;
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
  const walletElement = document.querySelector(`[data-wallet-index="${index}"]`);
  if (walletElement) {
    walletElement.classList.add('loading');
  }
  
  try {
    const wallet = wallets[index];
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    console.log('Refreshing wallet:', wallet.address);
    const walletData = await fetchWalletData(wallet.address);
    
    // Update wallet data
    wallet.balance = walletData.balance;
    wallet.assets = walletData.assets;
    wallet.stake_address = walletData.stake_address;
    wallet.timestamp = Date.now();
    
    // Save changes
    await saveWallets();
    
    // Update UI
    updateUI();
    showSuccess('Wallet data updated successfully!');
    
    console.log('Wallet refreshed:', {
      address: wallet.address,
      balance: wallet.balance,
      assetCount: wallet.assets.length
    });
  } catch (error) {
    console.error('Error refreshing wallet:', error);
    showError(error.message || 'Failed to refresh wallet');
  } finally {
    if (walletElement) {
      walletElement.classList.remove('loading');
    }
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
  // Convert lovelace to ADA (1 ADA = 1,000,000 lovelace)
  const adaValue = parseFloat(balance) / 1000000;
  return adaValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  }) + ' ₳';
}

function formatTokenAmount(amount, decimals = 0) {
  try {
    if (!amount) return '0';
    const value = BigInt(amount);
    if (decimals === 0) return value.toString();
    const divisor = BigInt(10 ** decimals);
    const wholePart = (value / divisor).toString();
    const fractionalPart = (value % divisor).toString().padStart(decimals, '0');
    return `${wholePart}.${fractionalPart}`;
  } catch (error) {
    console.error('Error formatting token amount:', error);
    return amount;
  }
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
    console.log('Raw wallet data:', data); // Debug log
    
    // Store complete asset data
    return {
      address: data.address,
      stake_address: data.stake_address,
      balance: data.balance,
      assets: data.assets?.map(asset => ({
        unit: asset.unit,
        quantity: asset.quantity,
        decimals: asset.decimals || 0,
        ticker: asset.ticker || '',
        name: asset.name || asset.unit,
        image: asset.image || '',
        description: asset.description || '',
        fingerprint: asset.fingerprint || '',
        metadata: asset.metadata || {},
        onchainMetadata: asset.onchainMetadata || {},
        is_nft: asset.quantity === '1' || asset.onchainMetadata?.type === 'NFT' || false
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
