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

function isNFT(asset) {
  // Check explicit NFT flag
  if (asset.is_nft === true) return true;
  
  // Check onchain metadata
  if (asset?.onchainMetadata?.type === 'NFT') return true;
  
  // Check for NFT characteristics
  const hasImage = asset?.onchainMetadata?.image || asset?.metadata?.image;
  const hasNFTMetadata = asset?.onchainMetadata?.name || asset?.onchainMetadata?.description;
  const isQuantityOne = asset.quantity === '1';
  
  // Consider it an NFT if it has quantity 1 AND either image or NFT metadata
  return isQuantityOne && (hasImage || hasNFTMetadata);
}

function getAssetImage(asset) {
  if (!asset) return null;
  
  // Check direct image property first
  if (asset.image && isValidUrl(asset.image)) {
    return convertIpfsUrl(asset.image);
  }

  // Check onchain metadata
  const onchainFields = ['image', 'logo', 'icon', 'mediaType', 'image1'];
  for (const field of onchainFields) {
    const url = asset.onchainMetadata?.[field];
    if (url && isValidUrl(url)) {
      return convertIpfsUrl(url);
    }
  }

  // Check metadata
  const metadataFields = ['image', 'logo', 'icon'];
  for (const field of metadataFields) {
    const url = asset.metadata?.[field];
    if (url && isValidUrl(url)) {
      return convertIpfsUrl(url);
    }
  }

  return null;
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
  const walletList = document.getElementById('walletList');
  if (!walletList) {
    console.error('Wallet list element not found');
    return;
  }
  
  // Check if wallets exist and is an array
  if (!Array.isArray(wallets) || wallets.length === 0) {
    walletList.innerHTML = '<div class="no-wallets">No wallets added yet</div>';
    return;
  }

  // Clear the existing wallets
  walletList.innerHTML = '';

  // Create wallet boxes
  wallets.forEach((wallet, index) => {
    if (!wallet) return; // Skip if wallet is undefined
    
    const walletBox = document.createElement('div');
    walletBox.className = 'wallet-item';
    
    // Create wallet header
    const header = document.createElement('div');
    header.className = 'wallet-header';
    header.innerHTML = `
      <div class="wallet-info">
        ${wallet.walletType && WALLET_LOGOS[wallet.walletType] ? `
          <img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}" class="wallet-icon">
        ` : ''}
        <div class="wallet-text">
          <div class="wallet-name">${wallet.name || 'Unnamed Wallet'}</div>
          <div class="wallet-address">${truncateAddress(wallet.address || '')}</div>
        </div>
      </div>
    `;
    
    // Create content sections
    const content = document.createElement('div');
    content.className = 'wallet-content';
    
    // General section
    const generalSection = document.createElement('div');
    generalSection.className = 'wallet-section active';
    generalSection.setAttribute('data-section', 'general');
    generalSection.innerHTML = `
      <div class="balance-group">
        <span class="balance-label">Balance:</span>
        <span class="balance-value">${formatBalance(wallet.balance || 0)} ₳</span>
      </div>
      <div class="action-buttons">
        <button class="action-button refresh" onclick="refreshWallet(${index})">
          <i class="fas fa-sync-alt"></i>
        </button>
        <button class="action-button copy" onclick="copyToClipboard('${wallet.address || ''}')">
          <i class="fas fa-copy"></i>
        </button>
        <button class="action-button delete" onclick="deleteWallet(${index})">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    
    // Assets section
    const assetsSection = document.createElement('div');
    assetsSection.className = 'wallet-section';
    assetsSection.setAttribute('data-section', 'assets');
    const nftCount = wallet.assets.filter(asset => isNFT(asset)).length;
    const tokenCount = wallet.assets.filter(asset => !isNFT(asset)).length;
    const assetsHTML = wallet.assets.map(asset => {
      const imageUrl = getAssetImage(asset);
      return `
        <div class="asset-thumbnail ${isNFT(asset) ? 'nft' : 'token'}">
          ${imageUrl ? `
            <img src="${imageUrl}" alt="${asset.name || asset.unit}">
          ` : `
            <span>${getFirstLetter(asset.name || asset.unit)}</span>
          `}
        </div>
      `;
    }).join('');
    assetsSection.innerHTML = `
        <div class="asset-filters">
            <button class="asset-filter-btn active" data-filter="all">
                <span class="asset-count">All (${nftCount + tokenCount})</span>
            </button>
            <button class="asset-filter-btn" data-filter="nfts">
                <span class="asset-count">${nftCount} NFTs</span>
            </button>
            <button class="asset-filter-btn" data-filter="tokens">
                <span class="asset-count">${tokenCount} Tokens</span>
            </button>
        </div>
        <div class="asset-grid">
            ${assetsHTML}
        </div>
    `;

    // Add click handlers for filter buttons
    const filterBtns = assetsSection.querySelectorAll('.asset-filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active class from all buttons
            filterBtns.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            btn.classList.add('active');
            
            const filter = btn.dataset.filter;
            const assetItems = assetsSection.querySelectorAll('.asset-thumbnail');
            
            assetItems.forEach(item => {
                if (filter === 'all') {
                    item.style.display = '';
                } else if (filter === 'nfts') {
                    item.style.display = item.classList.contains('nft') ? '' : 'none';
                } else if (filter === 'tokens') {
                    item.style.display = item.classList.contains('token') ? '' : 'none';
                }
            });
        });
    });

    // Staking section
    const stakingSection = document.createElement('div');
    stakingSection.className = 'wallet-section';
    stakingSection.setAttribute('data-section', 'staking');
    stakingSection.innerHTML = `
      <div class="staking-info">
        <div class="stake-pool">
          ${wallet.stakingInfo ? `
            <div>Pool: ${wallet.stakingInfo.poolName || 'Not delegated'}</div>
            <div>Rewards: ${formatBalance(wallet.stakingInfo.rewards || 0)} ₳</div>
          ` : 'Staking information not available'}
        </div>
      </div>
    `;
    
    content.appendChild(generalSection);
    content.appendChild(assetsSection);
    content.appendChild(stakingSection);
    
    // Create bottom navigation
    const nav = document.createElement('div');
    nav.className = 'wallet-nav';
    nav.innerHTML = `
      <button class="wallet-nav-button active" data-section="general">
        <i class="fas fa-wallet"></i>
        General
      </button>
      <button class="wallet-nav-button" data-section="assets">
        <i class="fas fa-coins"></i>
        Assets
      </button>
      <button class="wallet-nav-button" data-section="staking">
        <i class="fas fa-chart-line"></i>
        Staking
      </button>
    `;
    
    walletBox.appendChild(header);
    walletBox.appendChild(content);
    walletBox.appendChild(nav);
    
    // Add navigation event listeners
    nav.querySelectorAll('.wallet-nav-button').forEach(button => {
      button.addEventListener('click', () => {
        // Update active button
        nav.querySelectorAll('.wallet-nav-button').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        
        // Update active section
        const sectionName = button.getAttribute('data-section');
        content.querySelectorAll('.wallet-section').forEach(section => {
          section.classList.toggle('active', section.getAttribute('data-section') === sectionName);
        });
      });
    });
    
    walletList.appendChild(walletBox);
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

  // Add view assets button listeners
  document.querySelectorAll('.view-assets-btn').forEach(button => {
    button.addEventListener('click', () => {
      const walletItem = button.closest('.wallet-item');
      const mainPanel = walletItem.querySelector('.main-panel');
      const assetsPanel = walletItem.querySelector('.assets-panel');
      
      mainPanel.classList.remove('active');
      assetsPanel.classList.add('active');
    });
  });

  // Add back button listeners
  document.querySelectorAll('.back-to-wallet').forEach(button => {
    button.addEventListener('click', () => {
      const walletItem = button.closest('.wallet-item');
      const mainPanel = walletItem.querySelector('.main-panel');
      const assetsPanel = walletItem.querySelector('.assets-panel');
      
      assetsPanel.classList.remove('active');
      mainPanel.classList.add('active');
    });
  });

  // Add asset tab button listeners
  document.querySelectorAll('.asset-tab-btn').forEach(button => {
    button.addEventListener('click', () => {
      const assetsPanel = button.closest('.assets-panel');
      const tabType = button.dataset.type;
      
      // Update active tab button
      assetsPanel.querySelectorAll('.asset-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn === button);
      });
      
      // Update active grid
      assetsPanel.querySelectorAll('.assets-grid').forEach(grid => {
        grid.classList.toggle('active', grid.classList.contains(tabType));
      });
    });
  });
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
    wallets[index] = {
      ...wallet,
      balance: walletData.balance,
      assets: walletData.assets,
      stake_address: walletData.stake_address,
      timestamp: Date.now()
    };
    
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
  renderWallets();
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
  console.log('Starting fetchWalletData for address:', address);
  try {
    const url = `${API_BASE_URL}/api/wallet/${address}`;
    console.log('Making request to:', url);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': chrome.runtime.getURL('')
      }
    });
    
    if (!response.ok) {
      console.error('Server response not OK:', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Raw server response:', JSON.stringify(data, null, 2));
    
    if (!data.assets || !Array.isArray(data.assets)) {
      console.error('Invalid assets data received:', data.assets);
      throw new Error('Invalid asset data received from server');
    }

    // Log each asset for debugging
    data.assets.forEach((asset, index) => {
      console.log(`Asset ${index}:`, {
        unit: asset.unit,
        quantity: asset.quantity,
        name: asset.name,
        decimals: asset.decimals,
        metadata: asset.metadata,
        onchainMetadata: asset.onchainMetadata
      });
    });

    return {
      address: data.address,
      stake_address: data.stake_address,
      balance: data.balance,
      assets: data.assets.map(asset => ({
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
      }))
    };
  } catch (error) {
    console.error('Error in fetchWalletData:', error);
    if (error.message.includes('Failed to fetch')) {
      showError('Could not connect to server. Please check your internet connection and try again.');
    } else {
      showError(`Failed to fetch wallet data: ${error.message}`);
    }
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

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    updateUI();
  } catch (error) {
    console.error('Error initializing:', error);
    showError('Failed to initialize wallets. Please try again.');
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

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

function getFirstLetter(name) {
  return (name || 'A').charAt(0).toUpperCase();
}

function getRandomColor(text) {
  // Generate a consistent color based on text
  let hash = 0;
  for (let i = 0; i <text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 60%)`; // Consistent but random-looking color
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
