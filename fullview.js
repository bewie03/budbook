// Helper function to copy text
function copyToClipboard(text, element) {
  navigator.clipboard.writeText(text);
  element.classList.add('flash');
  setTimeout(() => element.classList.remove('flash'), 500);
}

// Import the shared constants and functions
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 5;
const MAX_TOTAL_SLOTS = 500;
const DEFAULT_PURCHASED_SLOTS = 35; // Default number of slots purchased by users
const BONE_PAYMENT_AMOUNT = 100;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';
const BONE_POLICY_ID = ''; // Add your BONE token policy ID here
const BONE_ASSET_NAME = ''; // Add your BONE token asset name here

const CURRENCIES = {
  'ADA': { symbol: '₳', rate: 1 },
  'USD': { symbol: '$', rate: 0 },
  'EUR': { symbol: '€', rate: 0 },
  'GBP': { symbol: '£', rate: 0 }
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache duration

// Available wallet logos
const WALLET_LOGOS = {
  'None': '',
  'Default': 'icons/default.png',
  'Pool.pm': 'icons/pool.pm.png',
  'Nami': 'icons/nami.png',
  'Eternal': 'icons/eternal.png',
  'Adalite': 'icons/adalite.png',
  'Vesper': 'icons/vesper.png',
  'Daedalus': 'icons/daedalus.png',
  'Gero': 'icons/gero.png',
  'Lace': 'icons/lace.png',
  'Custom': ''
};

let wallets = [];
let unlockedSlots = 0;
let selectedCurrency = 'ADA';

const MODAL_Z_INDEX = 999999;

// Cache management
const ASSET_CACHE_KEY = 'walletpup_asset_cache';

async function getAssetCache() {
  try {
    const cache = await chrome.storage.local.get(ASSET_CACHE_KEY);
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
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ [ASSET_CACHE_KEY]: cache });
    await updateStorageUsage();
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

// Request Queue System
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.retryDelays = [1000, 2000, 5000]; // Retry delays in ms
  }

  async add(request) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        request,
        resolve,
        reject,
        retries: 0
      });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const { request, resolve, reject, retries } = this.queue[0];

    try {
      await rateLimitRequest();
      const response = await fetch(request.url, request.options);
      
      if (!response.ok) {
        if (response.status === 429 && retries < this.retryDelays.length) {
          // Rate limited - push to back of queue with incremented retries
          this.queue[0].retries++;
          const delay = this.retryDelays[retries];
          await wait(delay);
          this.queue.push(this.queue.shift());
        } else {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
      } else {
        const data = await response.json();
        this.queue.shift();
        resolve(data);
      }
    } catch (error) {
      this.queue.shift();
      reject(error);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        setTimeout(() => this.process(), API_DELAY);
      }
    }
  }
}

const requestQueue = new RequestQueue();

async function loadWallets() {
  try {
    const data = await chrome.storage.sync.get(['wallet_index', 'unlockedSlots', 'slots_version', 'wallet_order']);
    const walletIndex = data.wallet_index || [];
    const savedOrder = data.wallet_order || [];
    
    // Reset slots if version is old or not set
    if (!data.slots_version || data.slots_version < 1) {
      console.log('Resetting slots to new default of 5');
      await chrome.storage.sync.set({ 
        unlockedSlots: MAX_FREE_SLOTS,
        slots_version: 1
      });
      unlockedSlots = MAX_FREE_SLOTS;
    } else if (!data.unlockedSlots) {
      chrome.storage.sync.set({ unlockedSlots: MAX_FREE_SLOTS });
      unlockedSlots = MAX_FREE_SLOTS;
    } else {
      unlockedSlots = data.unlockedSlots;
    }

    // Load wallets with metadata and cached data
    const tempWallets = {};
    const walletsNeedingRefresh = [];

    for (const address of walletIndex) {
      try {
        // Load stored metadata
        const storedData = await new Promise((resolve) => {
          chrome.storage.sync.get(`wallet_${address}`, (result) => {
            resolve(result[`wallet_${address}`] || {});
          });
        });

        // Load custom icon if present
        const iconData = await new Promise((resolve) => {
          chrome.storage.local.get(`wallet_icon_${address}`, (result) => {
            resolve(result[`wallet_icon_${address}`] || {});
          });
        });

        // Check local storage cache
        const cacheKey = `wallet_data_${address}`;
        const cache = await chrome.storage.local.get(cacheKey);
        const now = Date.now();
        
        let needsRefresh = true;
        let walletData = {
          balance: '0',
          assets: [],
          stakingInfo: null
        };
        
        if (cache[cacheKey]) {
          if (now - cache[cacheKey].timestamp < CACHE_DURATION) {
            // Cache exists and is fresh
            console.log('Using cached data for', address);
            walletData = cache[cacheKey].data;
            needsRefresh = false;
          }
        }

        // Combine all data
        tempWallets[address] = {
          address,
          ...storedData,
          ...walletData,
          customIcon: iconData.customIcon,
          isLoading: needsRefresh
        };

        if (needsRefresh) {
          walletsNeedingRefresh.push(address);
        }
      } catch (error) {
        console.error(`Error loading wallet ${address}:`, error);
        walletsNeedingRefresh.push(address);
      }
    }

    // Order wallets based on saved order
    wallets = [];
    
    // First add wallets in saved order
    for (const address of savedOrder) {
      if (tempWallets[address]) {
        wallets.push(tempWallets[address]);
        delete tempWallets[address];
      }
    }
    
    // Then add any remaining wallets
    for (const address of walletIndex) {
      if (tempWallets[address]) {
        wallets.push(tempWallets[address]);
      }
    }

    console.log('Loaded wallets:', wallets);
    console.log('Wallets needing refresh:', walletsNeedingRefresh);
    await updateStorageUsage();
    return walletsNeedingRefresh;
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
    return null;
  }
}

async function saveWallets() {
  try {
    await rateLimit(); // Add rate limiting before first storage operation
    
    // Save wallet index and order first (these are essential)
    const walletIndex = wallets.map(w => w.address);
    const walletOrder = wallets.map(w => w.address);
    
    await rateLimit(); // Add rate limiting before second storage operation
    await chrome.storage.sync.set({ 
      wallet_index: walletIndex,
      wallet_order: walletOrder 
    });
    await updateStorageUsage();

    // Save metadata for each wallet with longer delay to avoid quota
    for (const wallet of wallets) {
      const metadata = {
        name: wallet.name,
        walletType: wallet.walletType,
        address: wallet.address,
        lastUpdated: Date.now()
      };
      
      try {
        await rateLimit(); // Add rate limiting before each wallet save
        await chrome.storage.sync.set({ [`wallet_${wallet.address}`]: metadata });
        // Add a longer delay between writes to avoid hitting quota
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.warn(`Failed to save metadata for wallet ${wallet.address}:`, error);
        // Continue with other wallets even if one fails
      }
    }

    await updateStorageUsage();
    return true;
  } catch (error) {
    console.error('Error saving wallets:', error);
    if (error.message.includes('MAX_WRITE_OPERATIONS_PER_MINUTE')) {
      // If we hit the rate limit, wait a bit and try again
      await new Promise(resolve => setTimeout(resolve, 2000));
      await saveWallets(); // Retry the save
    } else {
      showError('Failed to save wallets');
      return false;
    }
  }
}

async function fetchWalletData(address, forceFresh = false) {
  try {
    // Check cache first (unless forceFresh is true)
    if (!forceFresh) {
      const cacheKey = `wallet_data_${address}`;
      const cache = await chrome.storage.local.get(cacheKey);
      
      if (cache[cacheKey]) {
        const now = Date.now();
        if (now - cache[cacheKey].timestamp < CACHE_DURATION) {
          console.log('Using cached data for', address);
          return cache[cacheKey].data;
        }
      }
    }

    // If server is not running, return empty data
    if (!isServerRunning) {
      console.log('Server not running, returning empty data');
      return {
        balance: '0',
        assets: [],
        stakingInfo: null
      };
    }

    console.log('Fetching fresh data for', address);
    const response = await fetch(`${API_BASE_URL}/api/wallet/${address}`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();

    // Get staking info
    let stakingInfo = null;
    if (data.stake_address) {
      try {
        const stakingResponse = await fetch(`${API_BASE_URL}/api/accounts/${data.stake_address}`);
        if (stakingResponse.ok) {
          stakingInfo = await stakingResponse.json();
        }
      } catch (error) {
        console.error('Error fetching staking info:', error);
      }
    }
    
    const walletData = {
      balance: data.balance || '0',
      assets: (data.assets || []).map(asset => ({
        unit: asset.unit,
        name: asset.name,
        fingerprint: asset.fingerprint,
        quantity: asset.quantity,
        isNFT: isNFT(asset),
        metadata: asset.metadata,
        onchainMetadata: asset.onchainMetadata,
        image: asset.image
      })),
      stakingInfo,
      stake_address: data.stake_address
    };

    // Cache the fresh data
    const cacheKey = `wallet_data_${address}`;
    await chrome.storage.local.set({
      [cacheKey]: {
        data: walletData,
        timestamp: Date.now()
      }
    });
    await updateStorageUsage();

    // Find wallet index and update stake_address if needed
    const walletIndex = wallets.findIndex(w => w.address === address);
    if (walletIndex !== -1 && data.stake_address) {
      wallets[walletIndex].stake_address = data.stake_address;
      await saveWallets();
    }

    return walletData;
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

// Add server status check
let isServerRunning = false;

async function checkServerStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    isServerRunning = response.ok;
  } catch (error) {
    isServerRunning = false;
  }
  return isServerRunning;
}

// Check server status periodically
setInterval(checkServerStatus, 30000); // Every 30 seconds
checkServerStatus(); // Initial check

async function cleanupCache() {
  try {
    const data = await chrome.storage.local.get(null);
    const now = Date.now();
    const keysToRemove = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('wallet_data_') && now - value.timestamp > CACHE_DURATION) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log('Cleaned up cache entries:', keysToRemove);
      await updateStorageUsage();
    }
  } catch (error) {
    console.error('Error cleaning up cache:', error);
  }
}

async function cleanupStorage() {
  try {
    const allData = await chrome.storage.local.get(null);
    const now = Date.now();
    const keysToRemove = [];

    // Get list of valid wallet addresses
    const validAddresses = wallets.map(w => w.address);

    // Check each storage key
    for (const key in allData) {
      // Remove expired wallet data caches
      if (key.startsWith('wallet_data_')) {
        const address = key.replace('wallet_data_', '');
        if (!validAddresses.includes(address)) {
          keysToRemove.push(key);
          continue;
        }
        if (now - allData[key].timestamp > CACHE_DURATION) {
          keysToRemove.push(key);
        }
      }
      
      // Remove expired or invalid asset caches
      if (key.startsWith('asset_') || key.startsWith('metadata_')) {
        const address = key.split('_')[1];
        if (!validAddresses.includes(address)) {
          keysToRemove.push(key);
        }
      }

      // Remove any null or undefined values
      if (allData[key] === null || allData[key] === undefined) {
        keysToRemove.push(key);
      }
    }

    // Remove all identified keys
    if (keysToRemove.length > 0) {
      console.log('Cleaning up storage keys:', keysToRemove);
      await chrome.storage.local.remove(keysToRemove);
      await updateStorageUsage();
    }
  } catch (error) {
    console.error('Error cleaning up storage:', error);
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
  // Basic validation - let the API handle detailed validation
  if (!address || typeof address !== 'string') return false;
  
  // Just check if it starts with a valid prefix
  const validPrefixes = ['addr1', 'Ae2', 'DdzFF', 'stake1'];
  const hasValidPrefix = validPrefixes.some(prefix => address.startsWith(prefix));
  
  // Minimum length check (reasonable minimum for any Cardano address)
  const hasValidLength = address.length >= 50;

  return hasValidPrefix && hasValidLength;
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
  
  // Helper to check and convert URL
  const processUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
      // Clean the URL first
      url = url.trim();
      if (!url) return null;
      
      // Skip base64 URLs
      if (url.startsWith('data:')) return null;
      
      // Convert IPFS URL if needed
      if (url.startsWith('ipfs://') || url.includes('/ipfs/')) {
        return convertIpfsUrl(url);
      }
      
      // Validate URL
      if (!isValidUrl(url)) return null;
      
      return url;
    } catch (error) {
      console.error('Error processing image URL:', error);
      return null;
    }
  };

  // Check direct image property first
  const directImage = processUrl(asset.image);
  if (directImage) return directImage;

  // Check onchain metadata
  if (asset.onchainMetadata) {
    const onchainFields = ['image', 'logo', 'icon', 'mediaType', 'image1'];
    for (const field of onchainFields) {
      const url = processUrl(asset.onchainMetadata[field]);
      if (url) return url;
    }
  }

  // Check metadata
  if (asset.metadata) {
    const metadataFields = ['image', 'logo', 'icon'];
    for (const field of metadataFields) {
      const url = processUrl(asset.metadata[field]);
      if (url) return url;
    }
  }

  return null;
}

function convertIpfsUrl(url) {
  if (!url) return null;
  
  // List of IPFS gateways to try
  const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/'
  ];

  try {
    // Clean the URL
    url = url.trim();
    
    // Handle ipfs:// protocol
    if (url.startsWith('ipfs://')) {
      const hash = url.replace('ipfs://', '');
      // Try the first gateway by default, others can be tried if image fails to load
      return `${IPFS_GATEWAYS[0]}${hash}`;
    }
    
    // Handle /ipfs/ paths
    if (url.includes('/ipfs/')) {
      const hash = url.split('/ipfs/')[1];
      return `${IPFS_GATEWAYS[0]}${hash}`;
    }
    
    // If it's already using a gateway but failing, try another gateway
    for (const gateway of IPFS_GATEWAYS) {
      if (url.includes(gateway)) {
        const hash = url.split(gateway)[1];
        const nextGatewayIndex = (IPFS_GATEWAYS.indexOf(gateway) + 1) % IPFS_GATEWAYS.length;
        return `${IPFS_GATEWAYS[nextGatewayIndex]}${hash}`;
      }
    }
    
    return url;
  } catch (error) {
    console.error('Error converting IPFS URL:', error);
    return url;
  }
}

function truncateAddress(address, startLength = 8, endLength = 8) {
  if (!address) return '';
  if (address.length <= startLength + endLength) return address;
  return `${address.slice(0, startLength)}...${address.slice(-endLength)}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
}

async function renderWallets() {
  const walletList = document.getElementById('walletList');

  if (!walletList) {
    console.error('Wallet list element not found');
    return;
  }
  
  // Check if wallets exist and is an array
  if (!Array.isArray(wallets) || wallets.length === 0) {
    walletList.innerHTML = '<div class="no-wallets">No wallets added yet</div>';
  } else {
    // Clear the existing wallets
    walletList.innerHTML = '';

    // Create wallet boxes
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      if (!wallet) continue; // Skip if wallet is undefined
      
      const walletBox = await createWalletBox(wallet, i);
      walletList.appendChild(walletBox);
    }
  }

  // Update slot count after rendering wallets
  await updateSlotCount();
}

async function createWalletBox(wallet, index) {
  const box = document.createElement('div');
  box.className = 'wallet-item';
  box.setAttribute('draggable', 'true');
  box.setAttribute('data-index', index);

  if (wallet.isLoading) {
    box.classList.add('loading');
    box.innerHTML = `
      <div class="wallet-header">
        <div class="wallet-info">
          ${wallet.walletType === 'Custom' && wallet.customIcon ? 
            `<img src="${wallet.customIcon}" alt="${wallet.name}" class="wallet-icon">` :
            wallet.walletType && WALLET_LOGOS[wallet.walletType] ? 
              `<img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}" class="wallet-icon">` : 
              ''}
          <div class="wallet-text">
            <div class="wallet-name">${wallet.name}</div>
            <div class="wallet-address">${truncateAddress(wallet.address)}</div>
          </div>
        </div>
      </div>
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <div class="loading-text">Fetching wallet data...</div>
      </div>
    `;
    return box;
  }

  // Add drag and drop event listeners
  box.addEventListener('dragstart', handleDragStart);
  box.addEventListener('dragend', handleDragEnd);
  box.addEventListener('dragover', handleDragOver);
  box.addEventListener('dragenter', handleDragEnter);
  box.addEventListener('dragleave', handleDragLeave);
  box.addEventListener('drop', handleDrop);

  // Create header
  const header = document.createElement('div');
  header.className = 'wallet-header';
  
  // Get wallet icon based on type
  let walletType = wallet.walletType || 'None';
  if (wallet.address.startsWith('$')) {
    walletType = 'Vesper';
  }

  // Get icon path or custom icon data
  let iconSrc = '';
  if (walletType === 'Custom' && wallet.customIcon) {
    iconSrc = wallet.customIcon;
  } else if (WALLET_LOGOS[walletType]) {
    iconSrc = WALLET_LOGOS[walletType];
  }

  header.innerHTML = `
    <div class="wallet-info">
      ${iconSrc ? `<img src="${iconSrc}" alt="${wallet.name}" class="wallet-icon">` : ''}
      <div class="wallet-text" role="button" title="Click to copy address">
        <div class="wallet-name">${wallet.name || 'Unnamed Wallet'}</div>
        <div class="wallet-address">${truncateAddress(wallet.address || '')}</div>
      </div>
    </div>
    <button class="delete-btn" title="Delete">×</button>
  `;

  // Add click handler for wallet info
  const walletText = header.querySelector('.wallet-text');
  walletText.addEventListener('click', async () => {
    await copyToClipboard(wallet.address);
    const walletName = walletText.querySelector('.wallet-name');
    const originalText = walletName.innerText;
    walletName.innerText = 'Copied!';
    walletName.style.color = '#00b894';
    setTimeout(() => {
      walletName.innerText = originalText;
      walletName.style.color = '';
    }, 1000);
  });

  // Add delete button event listener
  const deleteBtn = header.querySelector('.delete-btn');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const deleteConfirm = box.querySelector('.delete-confirm');
    deleteConfirm.classList.add('show');
  });

  // Create delete confirmation
  const deleteConfirm = document.createElement('div');
  deleteConfirm.className = 'delete-confirm';
  deleteConfirm.innerHTML = `
    <div class="confirm-text">Delete this wallet?</div>
    <div class="buttons">
      <button class="cancel-delete">Cancel</button>
      <button class="confirm-delete">Delete</button>
    </div>
  `;

  // Add event listeners for delete confirmation
  const cancelDelete = deleteConfirm.querySelector('.cancel-delete');
  const confirmDelete = deleteConfirm.querySelector('.confirm-delete');

  cancelDelete.addEventListener('click', () => {
    deleteConfirm.classList.remove('show');
  });

  confirmDelete.addEventListener('click', () => {
    deleteWallet(index);
  });

  box.appendChild(deleteConfirm);

  // Create content sections
  const contentContainer = document.createElement('div');
  contentContainer.className = 'wallet-content';

  // General section
  const generalSection = document.createElement('div');
  generalSection.className = 'wallet-section active';
  generalSection.setAttribute('data-section', 'general');

  // Create balance group
  const balanceGroup = document.createElement('div');
  balanceGroup.className = 'balance-group';
  balanceGroup.innerHTML = `
    <div class="balance-label">Balance:</div>
    <div class="balance-value">${wallet.isLoading ? '<div class="loading-spinner"></div>' : formatBalance(wallet.balance)}</div>
  `;

  // Create action buttons
  const actionButtons = document.createElement('div');
  actionButtons.className = 'action-buttons';
  actionButtons.innerHTML = `
    <button class="action-button refresh-btn" title="Refresh">
      <i class="fas fa-sync-alt"></i>
    </button>
  `;

  // Add refresh button event listener
  const refreshBtn = actionButtons.querySelector('.refresh-btn');
  refreshBtn.addEventListener('click', () => refreshWallet(index));

  // Assemble the sections
  generalSection.appendChild(balanceGroup);
  generalSection.appendChild(actionButtons);
  contentContainer.appendChild(generalSection);

  // Assets section
  const assetsSection = document.createElement('div');
  assetsSection.className = 'wallet-section';
  assetsSection.setAttribute('data-section', 'assets');
  const nftCount = wallet.assets.filter(asset => isNFT(asset)).length;
  const tokenCount = wallet.assets.filter(asset => !isNFT(asset)).length;

  // Create filter section
  const filterSection = document.createElement('div');
  filterSection.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin: 0;
    padding: 0 15px;
  `;

  // Create count display
  const countDisplay = document.createElement('div');
  countDisplay.style.cssText = `
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
    font-size: 13px;
    padding: 4px 12px;
    border-radius: 12px;
    min-width: 40px;
    text-align: center;
    margin-top: -8px;
  `;
  countDisplay.textContent = wallet.assets.length;

  // Create filter buttons container
  const filterContainer = document.createElement('div');
  filterContainer.className = 'asset-filters';
  filterContainer.style.cssText = `
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-bottom: -8px;
  `;

  // Create filter buttons
  const createFilterButton = (label, filter, isActive = false) => {
    const button = document.createElement('button');
    button.className = `action-button${isActive ? ' active' : ''}`;
    button.setAttribute('data-filter', filter);
    button.textContent = label;
    button.style.cssText = `
      min-width: 80px;
      padding: 6px 16px;
    `;
    return button;
  };

  const allButton = createFilterButton('All', 'all', true);
  const nftButton = createFilterButton('NFTs', 'nfts');
  const tokenButton = createFilterButton('Tokens', 'tokens');

  filterContainer.appendChild(allButton);
  filterContainer.appendChild(nftButton);
  filterContainer.appendChild(tokenButton);

  // Add click handlers for filter buttons
  [allButton, nftButton, tokenButton].forEach(btn => {
    btn.addEventListener('click', () => {
      // Update button styles
      [allButton, nftButton, tokenButton].forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      
      // Filter and display assets
      const filter = btn.getAttribute('data-filter');
      const filteredAssets = wallet.assets.filter(asset => {
        if (filter === 'all') return true;
        if (filter === 'nfts') return isNFT(asset);
        if (filter === 'tokens') return !isNFT(asset);
        return true;
      });

      // Update count display
      countDisplay.textContent = filteredAssets.length;

      // Clear and repopulate the assets grid
      assetsGrid.innerHTML = '';
      filteredAssets.forEach(asset => {
        const assetThumbnail = document.createElement('div');
        assetThumbnail.className = `asset-thumbnail ${isNFT(asset) ? 'nft' : 'token'}`;
        assetThumbnail.style.cursor = 'pointer';
        const imageUrl = getAssetImage(asset);
        
        assetThumbnail.innerHTML = imageUrl ? `
          <img src="${imageUrl}" alt="${asset.name || asset.unit}">
        ` : `
          <span style="background-color: ${getRandomColor(asset.name)}">${getFirstLetter(asset.name || asset.unit)}</span>
        `;
        
        assetThumbnail.addEventListener('click', (e) => {
          e.stopPropagation();
          assetModal.show(asset);
        });
        assetsGrid.appendChild(assetThumbnail);
      });
    });
  });

  // Add filter components to assets section
  filterSection.appendChild(countDisplay);
  filterSection.appendChild(filterContainer);
  assetsSection.appendChild(filterSection);

  // Create and add assets grid
  const assetsGrid = document.createElement('div');
  assetsGrid.className = 'asset-grid';
  assetsGrid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 15px;
    padding: 15px 15px 0;
  `;

  // Add assets to grid
  wallet.assets.forEach(asset => {
    const assetThumbnail = document.createElement('div');
    assetThumbnail.className = `asset-thumbnail ${isNFT(asset) ? 'nft' : 'token'}`;
    assetThumbnail.style.cursor = 'pointer';
    const imageUrl = getAssetImage(asset);
    
    assetThumbnail.innerHTML = imageUrl ? `
      <img src="${imageUrl}" alt="${asset.name || asset.unit}">
    ` : `
      <span style="background-color: ${getRandomColor(asset.name)}">${getFirstLetter(asset.name || asset.unit)}</span>
    `;
    
    assetThumbnail.addEventListener('click', (e) => {
      e.stopPropagation();
      assetModal.show(asset);
    });
    assetsGrid.appendChild(assetThumbnail);
  });

  assetsSection.appendChild(assetsGrid);

  // Staking section
  const stakingSection = document.createElement('div');
  stakingSection.className = 'wallet-section';
  stakingSection.setAttribute('data-section', 'staking');
  
  if (wallet.stakingInfo && wallet.stakingInfo.pool_info) {
    const rewards = wallet.stakingInfo.withdrawable_amount || '0';
    const formattedRewards = (parseInt(rewards) / 1000000).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    
    stakingSection.innerHTML = `
      <div class="staking-info">
        <div class="staking-group">
          <div class="staking-label">Pool</div>
          <div class="staking-value" style="font-size: 16px;">${wallet.stakingInfo.pool_info.metadata?.ticker || 'Unknown'}</div>
        </div>
        <div class="staking-group">
          <div class="staking-label">Rewards</div>
          <div class="staking-value" style="font-size: 16px;">₳ ${formattedRewards}</div>
        </div>
      </div>
    `;
  } else {
    stakingSection.innerHTML = `
      <div class="staking-info not-staking">
        <div class="staking-message">Not delegated</div>
      </div>
    `;
  }

  contentContainer.appendChild(generalSection);
  contentContainer.appendChild(assetsSection);
  contentContainer.appendChild(stakingSection);

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

  // Add navigation event listeners with fix for tab switching
  nav.querySelectorAll('.wallet-nav-button').forEach(button => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      // Get all buttons and sections in this wallet box
      const buttons = nav.querySelectorAll('.wallet-nav-button');
      const sections = contentContainer.querySelectorAll('.wallet-section');
      const targetSection = button.getAttribute('data-section');

      // Update button states
      buttons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      // Update section visibility
      sections.forEach(section => {
        section.classList.toggle('active', section.getAttribute('data-section') === targetSection);
      });
    });
  });

  box.appendChild(header);
  box.appendChild(contentContainer);
  box.appendChild(nav);

  // Add loading state if needed
  if (wallet.isLoading) {
    const balanceValue = box.querySelector('.balance-value');
    if (balanceValue) {
      balanceValue.classList.add('loading');
    }
  }

  return box;
}

async function fetchStakingInfo(stakeAddress) {
  try {
    console.log('Fetching staking info for stake address:', stakeAddress);
    
    // First get account info
    const response = await fetch(`${API_BASE_URL}/api/accounts/${stakeAddress}`);
    if (!response.ok) throw new Error('Failed to fetch staking info');
    
    const data = await response.json();

    // Get total rewards
    let totalRewards = '0';
    try {
      const rewardsResponse = await fetch(`${API_BASE_URL}/api/accounts/${stakeAddress}/rewards`);
      if (!rewardsResponse.ok) throw new Error('Failed to fetch rewards');
      const rewards = await rewardsResponse.json();
      totalRewards = rewards.reduce((sum, reward) => {
        return sum + parseInt(reward.amount || '0');
      }, 0).toString();
    } catch (error) {
      console.error('Error fetching rewards:', error);
      totalRewards = 'Error';
    }

    // Get ticker from pool info
    let ticker = 'Unstaked';
    if (data.pool_id && data.pool_info?.metadata) {
      ticker = data.pool_info.metadata.ticker || data.pool_info.metadata.name || `Pool ${data.pool_id.substring(0,8)}...`;
    }
    
    return {
      ticker,
      rewards: totalRewards,
      stake_address: stakeAddress,
      active: !!data.pool_id,
      error: null
    };
  } catch (error) {
    console.error('Error fetching staking info:', error);
    return {
      ticker: 'Error Loading',
      rewards: 'Error',
      stake_address: stakeAddress,
      active: false,
      error: error.message
    };
  }
}

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
  // Color palette for asset letters - more muted colors
  const COLORS = [
    '#2c3e50', // Dark Blue
    '#27ae60', // Muted Green
    '#c0392b', // Dark Red
    '#d35400', // Dark Orange
    '#8e44ad', // Dark Purple
    '#16a085', // Dark Teal
    '#7f8c8d', // Gray
    '#2980b9', // Muted Blue
  ];
  
  // Generate a consistent color based on text
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % COLORS.length;
  return COLORS[hue]; // Consistent but random-looking color
}

// Remove any existing message listeners
chrome.runtime.onMessage.removeListener(messageListener);

// Single message listener for all wallet-related events
async function messageListener(message, sender, sendResponse) {
  try {
    switch (message.type) {
      case 'WALLET_ADDED':
        // Add the wallet with loading state
        const newWallet = {
          ...message.wallet,
          isLoading: true,
          balance: '0',
          assets: [],
          stakingInfo: null
        };
        wallets.push(newWallet);
        await renderWallets(); // Show loading state immediately
        
        // Fetch data for the new wallet
        try {
          const data = await fetchWalletData(message.wallet.address, true);
          const walletIndex = wallets.findIndex(w => w.address === message.wallet.address);
          if (walletIndex !== -1) {
            // Update wallet with fetched data
            wallets[walletIndex] = {
              ...wallets[walletIndex],
              balance: data.balance || '0',
              assets: data.assets || [],
              stakingInfo: data.stakingInfo,
              stake_address: data.stake_address,
              name: wallet.name, // Preserve name
              walletType: wallet.walletType, // Preserve type
              lastUpdated: Date.now(), // Add timestamp
              isLoading: false
            };
            await saveWallets();
            await renderWallets();
          }
        } catch (error) {
          console.error('Error fetching wallet data:', error);
          const walletIndex = wallets.findIndex(w => w.address === message.wallet.address);
          if (walletIndex !== -1) {
            wallets[walletIndex].isLoading = false;
            await renderWallets();
          }
        }
        break;

      case 'REFRESH_WALLET':
        const walletToRefresh = wallets.find(w => w.address === message.address);
        if (walletToRefresh) {
          const index = wallets.indexOf(walletToRefresh);
          await refreshWallet(index);
        }
        break;

      case 'WALLET_UPDATED':
        const updatedWallet = message.wallet;
        const existingIndex = wallets.findIndex(w => w.address === updatedWallet.address);
        if (existingIndex !== -1) {
          wallets[existingIndex] = {
            ...wallets[existingIndex],
            ...updatedWallet
          };
          await saveWallets();
          await renderWallets();
        }
        break;

      case 'WALLET_DELETED':
        const addressToDelete = message.address;
        const deleteIndex = wallets.findIndex(w => w.address === addressToDelete);
        if (deleteIndex !== -1) {
          wallets.splice(deleteIndex, 1);
          await saveWallets();
          await renderWallets();
        }
        break;

      case 'REFRESH_ALL_WALLETS':
        console.log('Received refresh request from popup');
        loadWallets().then(async (walletsNeedingRefresh) => {
          await loadWallets();
          renderWallets();
          await updateSlotCount();
          
          // Queue refresh requests for wallets that need it
          for (const address of walletsNeedingRefresh) {
            requestQueue.add(address);
          }
        });
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

// Add the single message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Received message in fullview:', message);
  
  if (message.type === 'UPDATE_SLOT_COUNT') {
    console.log('Updating slot count from message:', message.data);
    if (message.data && typeof message.data.slots === 'number') {
      updateSlotCount().catch(err => console.error('Error updating slot count:', err));
    }
  } else if (message.action === 'REFRESH_ALL_WALLETS') {
    console.log('Refreshing all wallets...');
    loadWallets().then(async (walletsNeedingRefresh) => {
      // First load wallets from storage
      const data = await chrome.storage.sync.get(['wallet_index', 'unlockedSlots', 'slots_version', 'wallet_order']);
      const walletIndex = data.wallet_index || [];
      
      // Load each wallet's data
      for (const address of walletIndex) {
        const storedData = await chrome.storage.sync.get(`wallet_${address}`);
        const walletData = storedData[`wallet_${address}`] || {};
        const iconData = await chrome.storage.local.get(`wallet_icon_${address}`);
        
        // Add or update wallet in the wallets array
        const existingIndex = wallets.findIndex(w => w.address === address);
        if (existingIndex !== -1) {
          wallets[existingIndex] = {
            ...wallets[existingIndex],
            ...walletData,
            customIcon: iconData[`wallet_icon_${address}`]?.customIcon
          };
        } else {
          wallets.push({
            address,
            ...walletData,
            customIcon: iconData[`wallet_icon_${address}`]?.customIcon
          });
        }
      }

      // Update UI with new wallet data
      await loadWallets();
      renderWallets();
      await updateSlotCount();
      
      // Queue refresh requests for wallets that need it
      for (const address of walletsNeedingRefresh) {
        requestQueue.add(address);
      }
    });
  }
  // Must return true if we're using sendResponse asynchronously
  return true;
});

async function addWallet() {
  const name = document.getElementById('nameInput').value.trim();
  const address = document.getElementById('addressInput').value.trim();
  const walletType = document.getElementById('walletType').value;
  const addWalletBtn = document.getElementById('addWallet');

  // Validation
  if (!address) {
    showError('Please enter a wallet address');
    return;
  }
  if (!validateAddress(address)) {
    showError('Please enter a valid Cardano address');
    return;
  }
  if (!name) {
    showError('Please enter a wallet name');
    return;
  }
  if (wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) {
    showError('A wallet with this name already exists');
    return;
  }
  if (wallets.some(w => w.address === address)) {
    showError('This wallet has already been added');
    return;
  }
  if (wallets.length >= unlockedSlots) {
    showError('No available slots. Please unlock more slots.');
    return;
  }

  addWalletBtn.disabled = true;
  showMessage('Adding wallet...', 'info');

  try {
    // Create the wallet object with loading state
    const newWallet = {
      name,
      address,
      walletType,
      customIcon: walletType === 'Custom' ? customIconData : undefined,
      isLoading: true
    };

    // Add wallet to list first to show loading state
    wallets.push(newWallet);
    await renderWallets(); // Show loading state immediately
    
    // Fetch wallet data
    const data = await fetchWalletData(address, true);
    
    // Update wallet with fetched data
    const walletIndex = wallets.length - 1;
    Object.assign(wallets[walletIndex], {
      balance: data.balance || '0',
      assets: data.assets || [],
      stakingInfo: data.stakingInfo,
      stake_address: data.stake_address,
      name: wallet.name, // Preserve name
      walletType: wallet.walletType, // Preserve type
      lastUpdated: Date.now(), // Add timestamp
      isLoading: false
    });

    // Save and re-render
    await saveWallets();
    await renderWallets();

    // Add cool animation class to the new wallet box
    const walletBox = document.querySelector(`[data-index="${walletIndex}"]`);
    if (walletBox) {
      walletBox.classList.add('wallet-added');
      setTimeout(() => walletBox.classList.remove('wallet-added'), 1000);
    }

    // Clear form
    document.getElementById('nameInput').value = '';
    document.getElementById('addressInput').value = '';
    document.getElementById('walletType').value = 'None';
    customIconData = null;

    showSuccess('Wallet added successfully!');
  } catch (error) {
    console.error('Error adding wallet:', error);
    // Remove the wallet if it failed
    wallets.pop();
    await renderWallets();
    showError('Failed to add wallet');
  } finally {
    addWalletBtn.disabled = false;
  }
}

async function refreshWallet(index) {
  try {
    const wallet = wallets[index];
    if (!wallet) return false;

    // Find and trigger the refresh button animation
    const refreshButton = document.querySelector(`[data-index="${index}"] .refresh-btn i`);
    if (refreshButton) {
      refreshButton.classList.add('rotating');
    }

    // Add loading state
    const walletBox = document.querySelector(`[data-index="${index}"]`);
    if (walletBox) {
      walletBox.classList.add('loading');
    }

    // Clear all caches for this wallet
    const walletCacheKey = `wallet_data_${wallet.address}`;
    await chrome.storage.local.remove(walletCacheKey);
    
    // Clear all asset caches
    const localStorage = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(localStorage).filter(key => 
      key.startsWith(`asset_${wallet.address}_`) || 
      key.startsWith(`metadata_${wallet.address}_`) ||
      (key === ASSET_CACHE_KEY && localStorage[key]?.[wallet.address])
    );
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    await updateStorageUsage();

    // Force fresh data fetch
    const data = await fetchWalletData(wallet.address, true);
    if (!data) {
      throw new Error('Failed to fetch wallet data');
    }
    
    // Update wallet with new data
    Object.assign(wallet, {
      balance: data.balance || '0',
      assets: data.assets || [],
      stakingInfo: data.stakingInfo,
      stake_address: data.stake_address, // Add stake_address
      name: wallet.name, // Preserve name
      walletType: wallet.walletType, // Preserve type
      lastUpdated: Date.now(), // Add timestamp
      isLoading: false
    });

    // Save to storage and update UI
    await saveWallets();
    await renderWallets();
    
    return true;
  } catch (error) {
    console.error('Error refreshing wallet:', error);
    showError(error.message || 'Failed to refresh wallet');
    return false;
  } finally {
    // Remove loading states
    const walletBox = document.querySelector(`[data-index="${index}"]`);
    const refreshButton = document.querySelector(`[data-index="${index}"] .refresh-btn i`);
    if (walletBox) {
      walletBox.classList.remove('loading');
    }
    if (refreshButton) {
      refreshButton.classList.remove('rotating');
    }
  }
}

function createAssetModal() {
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'asset-modal-overlay';
  modalOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.85);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: ${MODAL_Z_INDEX};
    backdrop-filter: blur(5px);
  `;

  const modalContent = document.createElement('div');
  modalContent.className = 'asset-modal-content';
  modalContent.style.cssText = `
    background: var(--bg-secondary);
    padding: 25px;
    border-radius: 16px;
    width: 90%;
    max-width: 500px;
    max-height: 90vh;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    overflow-y: auto;
  `;

  const closeButton = document.createElement('button');
  closeButton.innerHTML = '×';
  closeButton.style.cssText = `
    position: absolute;
    top: 15px;
    right: 15px;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background 0.2s;
    &:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  `;

  const imageContainer = document.createElement('div');
  imageContainer.className = 'asset-modal-image-container';
  imageContainer.style.cssText = `
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 150px;
    max-height: 50vh;
    overflow: hidden;
    border-radius: 8px;
  `;

  const assetInfo = document.createElement('div');
  assetInfo.style.cssText = `
    color: var(--text-primary);
    font-size: 14px;
  `;

  modalContent.appendChild(closeButton);
  modalContent.appendChild(imageContainer);
  modalContent.appendChild(assetInfo);
  modalOverlay.appendChild(modalContent);
  document.body.appendChild(modalOverlay);

  closeButton.addEventListener('click', () => {
    modalOverlay.style.display = 'none';
  });

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.style.display = 'none';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.style.display === 'flex') {
      modalOverlay.style.display = 'none';
    }
  });

  return {
    show: (asset) => {
      imageContainer.innerHTML = '';
      
      const imageUrl = getAssetImage(asset);
      
      if (imageUrl) {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = asset.name || asset.unit;
        img.style.cssText = `
          width: 300px;
          height: 300px;
          object-fit: contain;
          border-radius: 8px;
        `;
        imageContainer.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
          width: 300px;
          height: 300px;
          background-color: ${getRandomColor(asset.name)};
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 72px;
          color: white;
        `;
        placeholder.textContent = getFirstLetter(asset.name || asset.unit);
        imageContainer.appendChild(placeholder);
      }

      // Format the asset information
      const quantity = asset.quantity;
      const ticker = asset.ticker ? ` (${asset.ticker})` : '';
      const displayName = asset.name || 'Unnamed Asset';
      
      // Create a truncated version of long IDs
      const truncateId = (id) => {
        if (!id) return '';
        if (id.length <= 20) return id;
        return `${id.slice(0, 8)}...${id.slice(-8)}`;
      };

      assetInfo.innerHTML = `
        <div style="
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          padding-bottom: 15px;
          margin-bottom: 15px;
        ">
          <div style="font-size: 20px; font-weight: 600; margin-bottom: 5px;">
            ${displayName}${ticker}
          </div>
          <div style="font-size: 16px; color: var(--text-secondary);">
            Quantity: ${quantity}
          </div>
        </div>
        
        <div style="
          display: grid;
          gap: 12px;
          font-family: monospace;
          background: rgba(0, 0, 0, 0.2);
          padding: 15px;
          border-radius: 8px;
        ">
          ${asset.fingerprint ? `
            <div>
              <div style="color: var(--text-secondary); font-size: 12px;">Fingerprint</div>
              <div class="copyable-text" data-copy="${asset.fingerprint}" style="word-break: break-all; cursor: pointer;">${asset.fingerprint}</div>
            </div>
          ` : ''}
          
          <div>
            <div style="color: var(--text-secondary); font-size: 12px;">Policy ID</div>
            <div class="copyable-text" data-copy="${asset.unit}" style="word-break: break-all; cursor: pointer;">${asset.unit}</div>
          </div>
          
          ${asset.policy ? `
            <div>
              <div style="color: var(--text-secondary); font-size: 12px;">Policy ID</div>
              <div class="copyable-text" data-copy="${asset.policy}" style="word-break: break-all; cursor: pointer;">${asset.policy}</div>
            </div>
          ` : ''}
        </div>
        
        ${asset.description ? `
          <div style="margin-top: 15px; color: var(--text-secondary);">
            ${asset.description}
          </div>
        ` : ''}
      `;

      // Add click handlers for copyable text elements
      const copyableElements = assetInfo.querySelectorAll('.copyable-text');
      copyableElements.forEach(element => {
        element.addEventListener('click', async () => {
          const textToCopy = element.getAttribute('data-copy');
          await navigator.clipboard.writeText(textToCopy);
          
          // Visual feedback
          const originalText = element.textContent;
          element.textContent = 'Copied!';
          element.style.color = '#00b894';
          
          setTimeout(() => {
            element.textContent = originalText;
            element.style.color = '';
          }, 1000);
        });
      });

      modalOverlay.style.display = 'flex';
    }
  };
}

let assetModal = createAssetModal();

// Modal elements
let modal;
let modalImage;
let modalName;
let modalAmount;
let modalPolicy;
let closeModalButton;

// Initialize modal elements
function initializeModal() {
  modal = document.getElementById('assetModal');
  modalImage = document.getElementById('modalAssetImage');
  modalName = document.getElementById('modalAssetName');
  modalAmount = document.getElementById('modalAssetAmount');
  modalPolicy = document.getElementById('modalAssetPolicy');
  closeModalButton = document.querySelector('.close-modal');

  // Close modal when clicking X or outside
  if (closeModalButton) {
    closeModalButton.onclick = () => modal.style.display = 'none';
  }
  
  window.onclick = (event) => {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
  };
}

// Modal functionality
function showAssetModal(asset) {
  if (!modal) return; // Guard against modal not being initialized
  
  modal.style.display = 'block';
  
  // Set image or fallback
  const imageUrl = getAssetImage(asset);
  if (imageUrl) {
    modalImage.src = imageUrl;
    modalImage.style.display = 'block';
  } else {
    modalImage.style.display = 'none';
  }
  
  // Set name and quantity
  modalName.textContent = asset.name || asset.unit;
  console.log('Displaying asset in modal:', {
    name: asset.name,
    quantity: asset.quantity,
    raw: asset
  });
  modalAmount.textContent = `Quantity: ${asset.quantity}`;
  
  // Set policy ID
  if (modalPolicy) {
    modalPolicy.textContent = asset.policy || '';
  }
}

// Update createAssetCard to add click handler
function createAssetCard(asset) {
  const card = document.createElement('div');
  card.className = 'asset-card';
  
  const content = document.createElement('div');
  content.className = 'asset-content';
  
  const image = document.createElement('img');
  image.className = 'asset-image';
  image.src = asset.image || 'icons/placeholder.png';
  image.alt = asset.name || 'Asset';
  image.onerror = () => image.src = 'icons/placeholder.png';
  
  const info = document.createElement('div');
  info.className = 'asset-info';
  
  const name = document.createElement('div');
  name.className = 'asset-name';
  name.textContent = asset.name || 'Unnamed Asset';
  
  const amount = document.createElement('div');
  amount.className = 'asset-amount';
  amount.textContent = asset.quantity;
  
  info.appendChild(name);
  info.appendChild(amount);
  
  content.appendChild(image);
  content.appendChild(info);
  
  // Add click handler to content area
  content.onclick = (e) => {
    // Only show modal if not dragging
    if (!isDragging) {
      showAssetModal(asset);
    }
  };
  
  card.appendChild(content);
  return card;
}

// Track dragging state
let isDragging = false;

// Update drag start/end handlers
function handleDragStart(e) {
  isDragging = true;
  // ... rest of drag start code
}

function handleDragEnd(e) {
  isDragging = false;
  // ... rest of drag end code
}

// Initial load
console.log('Setting up page load handlers...');

function setupBuyButton() {
  console.log('Setting up buy button...');
  const buyButton = document.getElementById('buySlots');
  console.log('Found button by ID:', buyButton);
  
  if (buyButton) {
    // Remove any existing listeners first
    buyButton.replaceWith(buyButton.cloneNode(true));
    const newBuyButton = document.getElementById('buySlots');
    
    console.log('Adding click handler to button');
    newBuyButton.addEventListener('click', async () => {
      console.log('Button clicked! Creating modal...');
    
      // Create and show modal
      const modal = document.createElement('div');
      modal.className = 'payment-modal';
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(26, 27, 31, 0.95);
        backdrop-filter: blur(5px);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
      `;
      
      modal.innerHTML = `
        <div class="modal-content" style="
          background: var(--card-bg);
          color: var(--text-color);
          padding: 24px;
          border-radius: var(--border-radius);
          width: 90%;
          max-width: 500px;
          position: relative;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          border: 1px solid var(--border-color);
        ">
          <div class="modal-header" style="margin-bottom: 24px;">
            <h2 style="margin: 0; color: var(--text-color); font-size: 24px;">Buy More Slots</h2>
            <div class="payment-status" style="
              margin-top: 12px;
              padding: 8px 16px;
              border-radius: 20px;
              background: rgba(255, 255, 255, 0.1);
              font-size: 14px;
              color: var(--text-secondary);
            ">Initializing payment...</div>
          </div>
          
          <div class="payment-details">
            <div style="text-align: center; margin: 24px 0;">
              <div style="font-size: 1.4em; margin: 10px 0; color: var(--text-color);">Processing...</div>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button class="modal-button secondary" style="
              padding: 10px 20px;
              border: 1px solid var(--border-color);
              background: transparent;
              color: var(--text-color);
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            ">Cancel</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
      
      // Add initial button handler
      const cancelButton = modal.querySelector('.modal-button.secondary');
      cancelButton.onclick = () => modal.remove();

      try {
        console.log('Starting payment process...');
        const response = await fetch(`${API_BASE_URL}/api/initiate-payment`, {
      method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': chrome.runtime.getURL('')
          },
          body: JSON.stringify({
            userId: chrome.runtime.id
          })
        });

    if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
          }
          throw new Error(errorData.error || 'Failed to initiate payment');
        }
        
        const { paymentId, address, adaAmount, boneAmount } = await response.json();
        
        // Update modal content with payment details
        const modalContent = modal.querySelector('.modal-content');
        modalContent.innerHTML = `
          <div class="modal-header" style="margin-bottom: 24px;">
            <h2 style="margin: 0; color: var(--text-color); font-size: 24px;">Buy More Slots</h2>
            <div class="payment-status" style="
              margin-top: 12px;
              padding: 8px 16px;
              border-radius: 20px;
              background: rgba(255, 255, 255, 0.1);
              font-size: 14px;
              color: var(--text-secondary);
            ">Waiting for payment...</div>
          </div>
          
          <div class="payment-details">
            <div style="
              text-align: center;
              margin: 24px 0;
              padding: 20px;
              background: rgba(91, 134, 229, 0.1);
              border-radius: var(--border-radius);
            ">
              <div style="font-size: 1.6em; margin: 10px 0; color: var(--primary-color);">${boneAmount} BONE</div>
              <div style="font-size: 1.4em; margin: 10px 0; color: var(--text-color);">₳ ${adaAmount} ADA</div>
            </div>
            
            <div style="margin: 24px 0;">
              <div style="margin-bottom: 8px; color: var(--text-secondary);">Send to:</div>
              <div style="
                background: var(--input-bg);
                padding: 12px;
                border-radius: var(--border-radius);
                word-break: break-all;
                font-family: monospace;
                color: var(--text-color);
                border: 1px solid var(--border-color);
              ">${address}</div>
            </div>
            
            <div style="
              background: rgba(91, 134, 229, 0.1);
              color: var(--text-color);
              padding: 16px;
              border-radius: var(--border-radius);
              margin: 24px 0;
              border: 1px solid var(--primary-color);
            ">
              <strong style="color: var(--primary-color);">Important:</strong> Send EXACTLY ₳ ${adaAmount} ADA along with ${boneAmount} BONE tokens.
              This specific ADA amount helps us identify your payment.
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button class="modal-button secondary" style="
              padding: 10px 20px;
              border: 1px solid var(--border-color);
              background: transparent;
              color: var(--text-color);
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            ">Cancel</button>
            <button class="modal-button primary" style="
              padding: 10px 20px;
              border: none;
              background: var(--primary-color);
              color: white;
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
              box-shadow: 0 2px 8px rgba(91, 134, 229, 0.2);
            ">Check Status</button>
          </div>
        `;
        
        // Add updated button handlers
        const updatedCancelButton = modal.querySelector('.modal-button.secondary');
        const checkButton = modal.querySelector('.modal-button.primary');

        updatedCancelButton.onclick = () => modal.remove();
        
        checkButton.onclick = async () => {
          const statusDiv = modal.querySelector('.payment-status');
          statusDiv.textContent = 'Checking payment status...';

          try {
            const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
            if (!response.ok) throw new Error('Failed to verify payment');
            const { verified, used } = await response.json();

            if (verified) {
              if (used) {
                showError('This payment has already been used.');
                modal.remove();
          return;
        }

              statusDiv.textContent = 'Payment verified!';
              const { availableSlots } = await chrome.storage.local.get('availableSlots');
              await chrome.storage.local.set({
                availableSlots: (availableSlots || MAX_FREE_SLOTS) + SLOTS_PER_PAYMENT
              });
              await updateStorageUsage();

              showSuccess('Payment verified! Your slots have been added.');
              
              // Close modal after 2 seconds
              setTimeout(async () => {
                modal.remove();
                await loadWallets();
                renderWallets();
                updateSlotCount();
              }, 2000);
            } else {
              statusDiv.textContent = 'Payment not detected yet. Try again in a few moments.';
    }
  } catch (error) {
            console.error('Error checking payment:', error);
            statusDiv.textContent = 'Error checking payment status';
          }
        };

      } catch (error) {
        console.error('Payment error:', error);
        showError(error.message || 'Failed to initiate payment');
        modal.remove();
      }
    });
  } else {
    console.error('Buy button not found by ID!');
  }
}

// Try to set up the button immediately
setupBuyButton();

// Also try when DOM is loaded
document.addEventListener('DOMContentLoaded', setupBuyButton);

// And when the window loads (backup)
window.addEventListener('load', setupBuyButton);

let initialized = false;

async function initializePage() {
  console.log('initializePage called');
  if (initialized) {
    console.log('Already initialized, skipping...');
    return;
  }
  
  console.log('Starting initialization...');
  initialized = true;
  await init();
}

// Setup event listeners first
function setupEventListeners() {
  console.log('Setting up event listeners...');
  
  // Listen for messages from popup
  chrome.runtime.onMessage.addListener(messageListener);

  // Add buy slots button handler
  console.log('Looking for buy slots button...');
  const buySlots = document.getElementById('buySlots');
  console.log('Buy slots button found:', buySlots);
  
  if (buySlots) {
    // Remove any existing listeners first
    buySlots.replaceWith(buySlots.cloneNode(true));
    const newBuyButton = document.getElementById('buySlots');
    
    console.log('Adding click handler to button');
    newBuyButton.addEventListener('click', async () => {
      console.log('Button clicked! Creating modal...');
    
      // Create and show modal
      const modal = document.createElement('div');
      modal.className = 'payment-modal';
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(26, 27, 31, 0.95);
        backdrop-filter: blur(5px);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
      `;
      
      modal.innerHTML = `
        <div class="modal-content" style="
          background: var(--card-bg);
          color: var(--text-color);
          padding: 24px;
          border-radius: var(--border-radius);
          width: 90%;
          max-width: 500px;
          position: relative;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          border: 1px solid var(--border-color);
        ">
          <div class="modal-header" style="margin-bottom: 24px;">
            <h2 style="margin: 0; color: var(--text-color); font-size: 24px;">Buy More Slots</h2>
            <div class="payment-status" style="
              margin-top: 12px;
              padding: 8px 16px;
              border-radius: 20px;
              background: rgba(255, 255, 255, 0.1);
              font-size: 14px;
              color: var(--text-secondary);
            ">Initializing payment...</div>
          </div>
          
          <div class="payment-details">
            <div style="text-align: center; margin: 24px 0;">
              <div style="font-size: 1.4em; margin: 10px 0; color: var(--text-color);">Processing...</div>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button class="modal-button secondary" style="
              padding: 10px 20px;
              border: 1px solid var(--border-color);
              background: transparent;
              color: var(--text-color);
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            ">Cancel</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
      
      // Add initial button handler
      const cancelButton = modal.querySelector('.modal-button.secondary');
      cancelButton.onclick = () => modal.remove();

      try {
        console.log('Starting payment process...');
        const response = await fetch(`${API_BASE_URL}/api/initiate-payment`, {
      method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': chrome.runtime.getURL('')
          },
          body: JSON.stringify({
            userId: chrome.runtime.id
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
          }
          throw new Error(errorData.error || 'Failed to initiate payment');
        }
        
        const { paymentId, address, adaAmount, boneAmount } = await response.json();
        
        // Update modal content with payment details
        const modalContent = modal.querySelector('.modal-content');
        modalContent.innerHTML = `
          <div class="modal-header" style="margin-bottom: 24px;">
            <h2 style="margin: 0; color: var(--text-color); font-size: 24px;">Buy More Slots</h2>
            <div class="payment-status" style="
              margin-top: 12px;
              padding: 8px 16px;
              border-radius: 20px;
              background: rgba(255, 255, 255, 0.1);
              font-size: 14px;
              color: var(--text-secondary);
            ">Waiting for payment...</div>
          </div>
          
          <div class="payment-details">
            <div style="
              text-align: center;
              margin: 24px 0;
              padding: 20px;
              background: rgba(91, 134, 229, 0.1);
              border-radius: var(--border-radius);
            ">
              <div style="font-size: 1.6em; margin: 10px 0; color: var(--primary-color);">${boneAmount} BONE</div>
              <div style="font-size: 1.4em; margin: 10px 0; color: var(--text-color);">₳ ${adaAmount} ADA</div>
            </div>
            
            <div style="margin: 24px 0;">
              <div style="margin-bottom: 8px; color: var(--text-secondary);">Send to:</div>
              <div style="
                background: var(--input-bg);
                padding: 12px;
                border-radius: var(--border-radius);
                word-break: break-all;
                font-family: monospace;
                color: var(--text-color);
                border: 1px solid var(--border-color);
              ">${address}</div>
            </div>
            
            <div style="
              background: rgba(91, 134, 229, 0.1);
              color: var(--text-color);
              padding: 16px;
              border-radius: var(--border-radius);
              margin: 24px 0;
              border: 1px solid var(--primary-color);
            ">
              <strong style="color: var(--primary-color);">Important:</strong> Send EXACTLY ₳ ${adaAmount} ADA along with ${boneAmount} BONE tokens.
              This specific ADA amount helps us identify your payment.
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
            <button class="modal-button secondary" style="
              padding: 10px 20px;
              border: 1px solid var(--border-color);
              background: transparent;
              color: var(--text-color);
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
            ">Cancel</button>
            <button class="modal-button primary" style="
              padding: 10px 20px;
              border: none;
              background: var(--primary-color);
              color: white;
              border-radius: var(--border-radius);
              cursor: pointer;
              font-size: 14px;
              transition: all 0.2s;
              box-shadow: 0 2px 8px rgba(91, 134, 229, 0.2);
            ">Check Status</button>
          </div>
        `;
        
        // Add updated button handlers
        const updatedCancelButton = modal.querySelector('.modal-button.secondary');
        const checkButton = modal.querySelector('.modal-button.primary');

        updatedCancelButton.onclick = () => modal.remove();
        
        checkButton.onclick = async () => {
          const statusDiv = modal.querySelector('.payment-status');
          statusDiv.textContent = 'Checking payment status...';

          try {
            const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
            if (!response.ok) throw new Error('Failed to verify payment');
            const { verified, used } = await response.json();

            if (verified) {
              if (used) {
                showError('This payment has already been used.');
                modal.remove();
          return;
        }

              statusDiv.textContent = 'Payment verified!';
              const { availableSlots } = await chrome.storage.local.get('availableSlots');
              await chrome.storage.local.set({
                availableSlots: (availableSlots || MAX_FREE_SLOTS) + SLOTS_PER_PAYMENT
              });
              await updateStorageUsage();

              showSuccess('Payment verified! Your slots have been added.');
              
              // Close modal after 2 seconds
              setTimeout(async () => {
                modal.remove();
                await loadWallets();
                renderWallets();
                updateSlotCount();
              }, 2000);
            } else {
              statusDiv.textContent = 'Payment not detected yet. Try again in a few moments.';
    }
  } catch (error) {
            console.error('Error checking payment:', error);
            statusDiv.textContent = 'Error checking payment status';
          }
        };

      } catch (error) {
        console.error('Payment error:', error);
        showError(error.message || 'Failed to initiate payment');
        modal.remove();
      }
    });
  } else {
    console.error('Buy button not found by ID!');
  }
}

// Rate limiting for storage operations
const STORAGE_RATE_LIMIT = {
  operations: 0,
  lastReset: Date.now(),
  maxOperations: 30, // Maximum operations per minute
  resetInterval: 60000, // Reset counter every minute
};

async function rateLimit() {
  const now = Date.now();
  if (now - STORAGE_RATE_LIMIT.lastReset >= STORAGE_RATE_LIMIT.resetInterval) {
    STORAGE_RATE_LIMIT.operations = 0;
    STORAGE_RATE_LIMIT.lastReset = now;
  }

  if (STORAGE_RATE_LIMIT.operations >= STORAGE_RATE_LIMIT.maxOperations) {
    throw new Error('Storage operation rate limit exceeded. Please try again in a minute.');
  }

  STORAGE_RATE_LIMIT.operations++;
}

// Slot Manager for handling slot-related operations
class SlotManager {
  constructor() {
    this.cache = new Map();
  }

  async getSlots(userId) {
    try {
      await rateLimit();
      const response = await chrome.storage.sync.get([`slots:${userId}`]);
      return response[`slots:${userId}`] || 0;
    } catch (error) {
      console.error('Error getting slots:', error);
      return 0;
    }
  }

  async updateSlots(userId, newCount) {
    try {
      await rateLimit();
      await chrome.storage.sync.set({ [`slots:${userId}`]: newCount });
      
      // Update UI elements that show slot count
      const slotCountElements = document.querySelectorAll('.slot-count');
      slotCountElements.forEach(element => {
        element.textContent = newCount;
      });
      
      return true;
    } catch (error) {
      console.error('Error updating slots:', error);
      return false;
    }
  }

  async syncWithServer(userId) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/slots/${userId}`);
      if (!response.ok) throw new Error('Failed to fetch slots from server');
      
      const data = await response.json();
      await this.updateSlots(userId, data.slots);
      return data.slots;
    } catch (error) {
      console.error('Error initializing user profile:', error);
    }
    
    console.log('Loading wallets...');
    // Load wallets and get list of ones needing refresh
    const walletsNeedingRefresh = await loadWallets();
    if (walletsNeedingRefresh === null) {
      console.log('No wallets to refresh');
      return;
    }
    
    console.log('Rendering wallets...');
    // Render wallets with any cached data we have
    await renderWallets();
    
    // Find all refresh buttons after rendering
    const refreshButtons = document.querySelectorAll('.refresh-btn');
    
    // Only refresh wallets that need it
    if (walletsNeedingRefresh.length > 0) {
      console.log('Refreshing wallets with expired/no cache:', walletsNeedingRefresh);
      
      // Start spinning only buttons for wallets being refreshed
      wallets.forEach((wallet, index) => {
        if (walletsNeedingRefresh.includes(wallet.address)) {
          const button = refreshButtons[index];
          if (button) {
            const icon = button.querySelector('i');
            if (icon) icon.classList.add('rotating');
          }
        }
      });
      
      // Refresh only the wallets that need it
      const refreshResults = await Promise.all(
        wallets.map((wallet, index) => 
          walletsNeedingRefresh.includes(wallet.address) 
            ? refreshWallet(index) 
            : Promise.resolve(false)
        )
      );
      
      // Save and re-render if any wallet was updated
      if (refreshResults.some(result => result)) {
        await saveWallets();
        await renderWallets();
      }
    } else {
      console.log('All wallets have valid cache, no refresh needed');
    }
    
    // Setup remaining UI elements
    console.log('Setting up UI elements...');
    setupGlobalTabs();
    setupAssetSearch();
    startCacheRefreshMonitor();
    setupTabSwitching();
    
    // Add initial storage update with a small delay to ensure all data is loaded
    setTimeout(async () => {
      await updateStorageUsage();
    }, 1000);
    
    // Add periodic storage update (every 30 seconds)
    setInterval(updateStorageUsage, 30000);
    
    console.log('Initialization complete!');
  } catch (error) {
    console.error('Error during initialization:', error);
    throw error;
  }
}

async function updateSlotCount() {
  try {
    // Get total slots from sync storage
    const { totalSlots } = await chrome.storage.sync.get(['totalSlots']);
    const slotCount = totalSlots || DEFAULT_PURCHASED_SLOTS; // Use the constant instead of hardcoded value

    console.log('Current slot count:', {
      used: wallets.length,
      total: slotCount,
      totalSlots
    });

    // Update slot count display
    const slotCountElement = document.getElementById('slotCount');
    if (slotCountElement) {
      slotCountElement.textContent = `${wallets.length}/${slotCount} slots`;
    }

    // Update progress bar
    const slotProgressBar = document.getElementById('slotProgressBar');
    if (slotProgressBar) {
      const percentage = (wallets.length / slotCount) * 100;
      slotProgressBar.style.width = `${percentage}%`;
    }

    // Update popup if it's open
    chrome.runtime.sendMessage({
      type: 'UPDATE_SLOT_COUNT',
      data: {
        current: wallets.length,
        total: slotCount
      }
    }).catch(() => {
      // Ignore error if popup is not open
    });

    return slotCount;
  } catch (error) {
    console.error('Error updating slot count:', error);
    return DEFAULT_PURCHASED_SLOTS; // Use the constant instead of hardcoded value
  }
}

// Add listener for storage changes to update UI
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.totalSlots) {
    console.log('Slots updated in storage:', changes.totalSlots);
    updateSlotCount();
  }
});

async function updateStorageUsage() {
  try {
    // Get all stored data to analyze
    const allData = await chrome.storage.local.get(null);
    console.log('All stored data:', allData);
    
    // Calculate total size
    let totalSize = 0;
    for (const key in allData) {
      const value = allData[key];
      if (value === null || value === undefined) {
        chrome.storage.local.remove(key);
        continue;
      }
      
      const jsonString = JSON.stringify(value);
      const size = new TextEncoder().encode(jsonString).length;
      console.log(`Size for ${key}:`, {
        rawValue: value,
        jsonSize: jsonString.length,
        byteSize: size
      });
      totalSize += size;
    }
    
    console.log('Total size in bytes:', totalSize);
    
    // Chrome local storage limit (usually 10MB = 10,485,760 bytes)
    const STORAGE_LIMIT = chrome.storage.local.QUOTA_BYTES || 10485760;
    console.log('Storage limit in bytes:', STORAGE_LIMIT);
    
    // Calculate MB used (with 2 decimal places)
    const mbUsed = totalSize / (1024 * 1024);
    const roundedMB = Math.round(mbUsed * 100) / 100;
    
    // Calculate percentage used (with 2 decimal places)
    const percentageUsed = (totalSize / STORAGE_LIMIT) * 100;
    const roundedPercentage = Math.round(percentageUsed * 100) / 100;
    
    console.log('Storage Usage', {
      mb: roundedMB,
      percentage: roundedPercentage
    });
    
    // Update UI
    const storageUsedElement = document.getElementById('storageUsed');
    if (storageUsedElement) {
      storageUsedElement.textContent = `${roundedMB} MB`;
      storageUsedElement.title = `${roundedPercentage}% of available storage`;
      console.log('Updated storage display:', storageUsedElement.textContent);
    }

  } catch (error) {
    console.error('Error updating storage usage:', error);
  }
}

const API_DELAY = 500; // ms between requests
let lastRequestTime = 0;

// Rate limiting for payment requests
let lastPaymentAttempt = 0;
const PAYMENT_COOLDOWN = 5000; // 5 seconds between payment attempts

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimitRequest() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < API_DELAY) {
    await wait(API_DELAY - timeSinceLastRequest);
  }
  
  lastRequestTime = Date.now();
}

async function initiatePayment() {
  try {
    // Check if enough time has passed since last attempt
    const now = Date.now();
    const timeSinceLastAttempt = now - lastPaymentAttempt;
    
    if (timeSinceLastAttempt < PAYMENT_COOLDOWN) {
      const waitTime = Math.ceil((PAYMENT_COOLDOWN - timeSinceLastAttempt) / 1000);
      showError(`Please wait ${waitTime} seconds before trying again`);
      return;
    }
    
    lastPaymentAttempt = now;
    
    // Get payment details from server
    const response = await fetch(`${API_BASE_URL}/api/initiate-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': chrome.runtime.getURL('')
      },
      body: JSON.stringify({
        userId: chrome.runtime.id
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
      }
      throw new Error(errorData.error || 'Failed to initiate payment');
    }
    
    const { paymentId, address, adaAmount, boneAmount } = await response.json();
    
    // Show payment details modal
    const modal = createModal(`
      <div class="modal-content">
        <div class="modal-header">
          <h2>Buy More Slots</h2>
          <div class="payment-status">Waiting for payment...</div>
        </div>
        
        <div class="payment-details">
          <div class="amount-display">
            <div class="payment-amount">${boneAmount} BONE</div>
            <div class="payment-amount">₳ ${adaAmount} ADA</div>
          </div>
          
          <div class="address-container">
            <span class="label">Send to:</span>
            <div class="address-box">
              <code>${address}</code>
              <button class="copy-btn" onclick="copyToClipboard('${address}', this)">Copy</button>
            </div>
          </div>
          <div class="payment-note">
            <p>Important: Send EXACTLY ₳ ${adaAmount} ADA along with ${boneAmount} BONE tokens.</p>
            <p>The specific ADA amount helps us identify your payment.</p>
          </div>
        </div>
      </div>
    `);

    // Setup SSE for real-time updates
    const eventSource = new EventSource(`${API_BASE_URL}/api/payment-status/${paymentId}`);
    
    eventSource.onmessage = async (event) => {
      const paymentStatus = JSON.parse(event.data);
      if (paymentStatus.verified) {
        eventSource.close();
        
        try {
          // Update storage with new slot count
          await chrome.storage.sync.set({ totalSlots: paymentStatus.slots });
          console.log('Updated storage with new slot count:', paymentStatus.slots);
          
          // Update UI with success
          const statusDiv = modal.querySelector('.payment-status');
          const detailsDiv = modal.querySelector('.payment-details');
          
          statusDiv.textContent = 'Payment Successful!';
          statusDiv.classList.add('success');
          
          detailsDiv.innerHTML = `
            <div class="success-message">
              <p>Thank you for your payment!</p>
              <p>You now have ${paymentStatus.slots} slots available.</p>
              <p>Transaction: <a href="https://cardanoscan.io/transaction/${paymentStatus.txHash}" target="_blank">${paymentStatus.txHash.substring(0,8)}...</a></p>
            </div>
          `;
          
          // Update slots and refresh wallets
          unlockedSlots = paymentStatus.slots;
          await loadWallets();
          renderWallets();
          await updateSlotCount();
        } catch (error) {
          console.error('Error updating storage or UI:', error);
          // Fallback to polling
          pollPaymentStatus(data.paymentId, modal);
        }
        
        // Close modal after 2 seconds
        setTimeout(() => {
          modal.remove();
        }, 2000);
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('SSE Error:', error);
      eventSource.close();
      // Fallback to polling
      pollPaymentStatus(data.paymentId, modal);
    };
    
    // Add modal cleanup
    modal.addEventListener('close', () => {
      if (eventSource) {
        eventSource.close();
      }
    });

  } catch (error) {
    console.error('Payment error:', error);
    showError(error.message || 'Failed to initiate payment');
    modal.remove();
  }
}

async function pollPaymentStatus(paymentId, modal) {
  let attempts = 0;
  const maxAttempts = 36; // 3 minutes total with increasing intervals
  
  const checkStatus = async () => {
    attempts++;
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
    const data = await response.json();

    if (data.verified) {
      eventSource.close();
      
      // Update status and add slots
      const statusDiv = modal.querySelector('.payment-status');
      const detailsDiv = modal.querySelector('.payment-details');
      
      statusDiv.textContent = 'Payment verified!';
      statusDiv.className = 'payment-status success';
      
      detailsDiv.innerHTML = `
        <div class="success-message">
          <p>Thank you for your payment!</p>
          <p>You now have ${data.slots} slots available.</p>
          <p>Transaction: <a href="https://cardanoscan.io/transaction/${data.txHash}" target="_blank">${data.txHash.substring(0, 8)}...</a></p>
        </div>
      `;
      
      // Update slots and refresh wallets
      unlockedSlots = data.slots;
      await loadWallets();
      renderWallets();
      await updateSlotCount();
      
      // Close modal after 2 seconds
      setTimeout(async () => {
        modal.remove();
        updateUI();
      }, 2000);
    } else {
      attempts++;
      // Calculate next delay with exponential backoff
      const nextDelay = Math.min(2000 * Math.pow(1.2, attempts), 10000); // Cap at 10 seconds
      setTimeout(checkStatus, nextDelay);
    }
  };
  
  checkStatus();
}

function formatBalance(balance) {
  // Convert null/undefined to 0
  const rawBalance = balance || 0;
  
  // Convert from lovelace to ADA (1 ADA = 1,000,000 lovelace)
  const adaValue = parseFloat(rawBalance) / 1000000;
  
  // Format with 2 decimal places
  return `₳ ${adaValue.toLocaleString(undefined, { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function createModal(html) {
  // Remove any existing modals
  const existingModals = document.querySelectorAll('.modal');
  existingModals.forEach(modal => modal.remove());
  
  // Create new modal
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = html;
  
  // Add click handler to close on background click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
  
  // Add to document
  document.body.appendChild(modal);
  
  // Add keydown handler for Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      modal.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  
  return modal;
}

function pollPaymentStatus(paymentId, modal) {
  let attempts = 0;
  const maxAttempts = 36; // 3 minutes total with increasing intervals
  
  const checkStatus = async () => {
    attempts++;
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
    const data = await response.json();

    if (data.verified) {
      eventSource.close();
      
      // Update status and add slots
      const statusDiv = modal.querySelector('.payment-status');
      const detailsDiv = modal.querySelector('.payment-details');
      
      statusDiv.textContent = 'Payment verified!';
      statusDiv.className = 'payment-status success';
      
      detailsDiv.innerHTML = `
        <div class="success-message">
          <p>Thank you for your payment!</p>
          <p>You now have ${data.slots} slots available.</p>
          <p>Transaction: <a href="https://cardanoscan.io/transaction/${data.txHash}" target="_blank">${data.txHash.substring(0, 8)}...</a></p>
        </div>
      `;
      
      // Update slots and refresh wallets
      unlockedSlots = data.slots;
      await loadWallets();
      renderWallets();
      await updateSlotCount();
      
      // Close modal after 2 seconds
      setTimeout(async () => {
        modal.remove();
        updateUI();
      }, 2000);
    } else {
      attempts++;
      // Calculate next delay with exponential backoff
      const nextDelay = Math.min(2000 * Math.pow(1.2, attempts), 10000); // Cap at 10 seconds
      setTimeout(checkStatus, nextDelay);
    }
  };
  
  checkStatus();
}

function formatTokenQuantity(amount, decimals = 0) {
  try {
    // For NFTs just return 1
    if (amount === '1' && decimals === 0) {
      return '1';
    }

    // Convert to float and apply decimals
    const floatAmount = parseFloat(amount) / (10 ** decimals);
    
    // Format with 6 decimal places and remove trailing zeros
    const formatted = floatAmount.toFixed(6).replace(/\.?0+$/, '');
    console.log('Formatting token:', { amount, decimals, result: formatted });
    return formatted;
  } catch (error) {
    console.error('Error formatting token quantity:', error);
    return amount.toString();
  }
}

// Add event listener for tab switching
function setupTabSwitching() {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('.wallet-nav-button');
    if (!button) return;

    const walletBox = button.closest('.wallet-item');
    if (!walletBox) return;

    e.preventDefault();
    e.stopPropagation();
    
    const section = button.getAttribute('data-section');

    // Update button states
    const navButtons = walletBox.querySelectorAll('.wallet-nav-button');
    navButtons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');

    // Update section visibility
    const sections = walletBox.querySelectorAll('.wallet-section');
    sections.forEach(s => {
      s.classList.toggle('active', s.getAttribute('data-section') === section);
    });
  });
}

async function deleteWallet(index) {
  try {
    const walletToDelete = wallets[index];
    if (!walletToDelete) {
      throw new Error('Wallet not found');
    }

    // Get the wallet element
    const walletElement = document.querySelector(`.wallet-item[data-index="${index}"]`);
    if (!walletElement) {
      throw new Error('Wallet element not found');
    }

    // Hide the delete confirmation immediately
    const deleteConfirm = walletElement.querySelector('.delete-confirm');
    deleteConfirm.classList.remove('show');

    // Add deleting class to trigger animation
    walletElement.classList.add('deleting');

    // Wait for animation to complete
    await new Promise(resolve => setTimeout(resolve, 400));

    // Remove custom icon if exists
    if (walletToDelete.walletType === 'Custom') {
      await chrome.storage.local.remove(`wallet_icon_${walletToDelete.address}`);
    }

    // Remove from array
    wallets.splice(index, 1);
    
    // Save changes
    await saveWallets();
    
    // Re-render UI
    await renderWallets();
  } catch (error) {
    console.error('Error deleting wallet:', error);
  }
}

function startCacheRefreshMonitor() {
  const CACHE_CHECK_INTERVAL = 60000; // Check cache every 60 seconds
  const CACHE_REFRESH_THRESHOLD = 0; // Removed early refresh trigger
  
  // Initialize progress bar
  const refreshBar = document.querySelector('.refresh-bar');
  const refreshTimeText = document.getElementById('refreshTime');
  let startTime = Date.now();
  let nextRefreshTime = startTime + CACHE_DURATION;

  // Update progress bar every second
  const updateProgressBar = () => {
    const now = Date.now();
    const remaining = nextRefreshTime - now;
    const progress = Math.max(0, remaining / CACHE_DURATION); // Calculate remaining percentage
    
    // Update progress bar with smooth transition
    refreshBar.style.transition = 'transform 1s linear';
    refreshBar.style.transform = `scaleX(${progress})`;
    
    // Update time text
    const secondsRemaining = Math.max(0, Math.ceil(remaining / 1000));
    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = secondsRemaining % 60;
    refreshTimeText.textContent = `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
    
    // If time's up, refresh all wallets
    if (remaining <= 0) {
      refreshAllWallets();
      startTime = Date.now();
      nextRefreshTime = startTime + CACHE_DURATION;
    }
    
    // Schedule next update
    requestAnimationFrame(updateProgressBar);
  };

  // Function to refresh all wallets
  const refreshAllWallets = async () => {
    console.log('Cache duration reached, refreshing all wallets');
    
    if (!wallets || wallets.length === 0) {
      return;
    }

    // Start refresh animations for all wallets
    wallets.forEach((_, index) => {
      const button = document.querySelector(`[data-index="${index}"] .refresh-btn i`);
      if (button) button.classList.add('rotating');
    });

    try {
      // Refresh all wallets in parallel
      const refreshResults = await Promise.all(
        wallets.map((_, index) => refreshWallet(index))
      );

      // If any wallet was updated, save and re-render
      if (refreshResults.some(result => result)) {
        await saveWallets();
        await renderWallets();
      }
    } catch (error) {
      console.error('Error refreshing all wallets:', error);
    }
  };

  // Start progress bar animation
  updateProgressBar();

  // Check for wallets that need immediate refresh
  setInterval(async () => {
    try {
      if (!wallets || wallets.length === 0) return;

      const now = Date.now();
      const timeUntilNextRefresh = nextRefreshTime - now;
      
      // Only trigger refresh if we're within 1 second of the scheduled time
      // This prevents any drift that might occur from setTimeout/setInterval inaccuracies
      if (timeUntilNextRefresh <= 1000) {
        refreshAllWallets();
        startTime = now;
        nextRefreshTime = startTime + CACHE_DURATION;
      }
    } catch (error) {
      console.error('Error in cache refresh monitor:', error);
    }
  }, CACHE_CHECK_INTERVAL);
}

function renderAssetsList(walletIndex, tabType) {
  const wallet = wallets[walletIndex];
  if (!wallet || !wallet.assets) return;

  const assetsContainer = document.querySelector('.assets-list');
  if (!assetsContainer) return;

  // Clear existing assets
  assetsContainer.innerHTML = '';

  // Filter assets based on tab type
  const filteredAssets = wallet.assets.filter(asset => {
    if (tabType === 'all') return true;
    if (tabType === 'nfts') return isNFT(asset);
    if (tabType === 'tokens') return !isNFT(asset);
    return true;
  });

  // Render filtered assets
  filteredAssets.forEach(asset => {
    const assetCard = createAssetCard(asset);
    assetsContainer.appendChild(assetCard);
  });
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
      
      // Update button styles
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Render assets for the selected tab
      renderAssetsList(currentWallet, tabType);
    });
  });
}

// Add global tab functionality
function setupGlobalTabs() {
  const globalTabs = document.querySelectorAll('.global-tab-btn');
  
  globalTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Update active state of global tabs
      globalTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Get all wallet sections
      const walletItems = document.querySelectorAll('.wallet-item');
      
      walletItems.forEach(wallet => {
        // Get all sections in this wallet
        const sections = wallet.querySelectorAll('.wallet-section');
        const buttons = wallet.querySelectorAll('.wallet-nav-button');
        
        // Update sections visibility
        sections.forEach(s => {
          s.classList.toggle('active', s.getAttribute('data-section') === tab.dataset.section);
        });
        
        // Update nav buttons state
        buttons.forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-section') === tab.dataset.section);
        });
      });
    });
  });
}

// Add asset search functionality
function setupAssetSearch() {
  const searchInput = document.getElementById('assetSearch');
  if (!searchInput) return;

  let searchTimeout;

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(() => {
      const searchTerm = e.target.value.toLowerCase().trim();
      console.log('Searching for:', searchTerm);
      
      const walletItems = document.querySelectorAll('.wallet-item');
      let hasVisibleWallets = false;

      walletItems.forEach(walletItem => {
        const walletIndex = walletItem.getAttribute('data-index');
        const wallet = wallets[walletIndex];
        
        if (!wallet || !wallet.assets) {
          walletItem.classList.add('hidden');
          return;
        }

        // Filter the wallet's assets
        const matchingAssets = wallet.assets.filter(asset => {
          const assetName = (asset.name || '').toLowerCase();
          const assetUnit = (asset.unit || '').toLowerCase();
          const assetPolicy = (asset.policyId || '').toLowerCase();
          const assetFingerprint = (asset.fingerprint || '').toLowerCase();
          
          return assetName.includes(searchTerm) || 
                 assetUnit.includes(searchTerm) || 
                 assetPolicy.includes(searchTerm) ||
                 assetFingerprint.includes(searchTerm);
        });

        const hasMatchingAsset = matchingAssets.length > 0;

        if (searchTerm === '') {
          walletItem.classList.remove('hidden');
          hasVisibleWallets = true;
          
          // Reset asset visibility
          walletItem.querySelectorAll('.asset-thumbnail').forEach(asset => {
            asset.classList.remove('hidden');
          });
        } else if (hasMatchingAsset) {
          walletItem.classList.remove('hidden');
          hasVisibleWallets = true;
          
          // Switch to assets tab for this wallet
          const sections = walletItem.querySelectorAll('.wallet-section');
          const buttons = walletItem.querySelectorAll('.wallet-nav-button');
          
          sections.forEach(s => {
            s.classList.toggle('active', s.getAttribute('data-section') === 'assets');
          });
          
          buttons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-section') === 'assets');
          });

          // Switch global tab to assets
          const globalTabs = document.querySelectorAll('.global-tab-btn');
          globalTabs.forEach(tab => {
            tab.classList.toggle('active', tab.getAttribute('data-section') === 'assets');
          });

          // Show/hide individual assets based on search
          walletItem.querySelectorAll('.asset-thumbnail').forEach((assetThumb, i) => {
            const asset = wallet.assets[i];
            if (asset) {
              const assetName = (asset.name || '').toLowerCase();
              const assetUnit = (asset.unit || '').toLowerCase();
              const assetPolicy = (asset.policyId || '').toLowerCase();
              const assetFingerprint = (asset.fingerprint || '').toLowerCase();
              
              const matches = assetName.includes(searchTerm) || 
                            assetUnit.includes(searchTerm) || 
                            assetPolicy.includes(searchTerm) ||
                            assetFingerprint.includes(searchTerm);
              
              assetThumb.classList.toggle('hidden', !matches);
            }
          });
        } else {
          walletItem.classList.add('hidden');
        }
      });

      // Show/hide no results message
      let noResultsMsg = document.getElementById('noResultsMsg');
      if (!hasVisibleWallets && searchTerm !== '') {
        if (!noResultsMsg) {
          noResultsMsg = document.createElement('div');
          noResultsMsg.id = 'noResultsMsg';
          noResultsMsg.className = 'no-results-message';
          noResultsMsg.textContent = 'No wallets found with matching assets';
          document.getElementById('walletList').appendChild(noResultsMsg);
        }
      } else if (noResultsMsg) {
        noResultsMsg.remove();
      }
    }, 300);
  });

  // Clear search when switching global tabs
  document.querySelectorAll('.global-tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      if (searchInput.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
      }
    });
  });
}

// Drag and drop functionality
let draggedItem = null;

function handleDragStart(e) {
  isDragging = true;
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.getAttribute('data-index'));
}

function handleDragEnd(e) {
  isDragging = false;
  this.classList.remove('dragging');
  document.querySelectorAll('.wallet-item').forEach(item => {
    item.classList.remove('drag-over');
  });
  draggedItem = null;
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDragEnter(e) {
  this.classList.add('drag-over');
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

async function handleDrop(e) {
  e.stopPropagation();
  e.preventDefault();
  
  if (draggedItem === this) return;
  
  this.classList.remove('drag-over');
  
  const fromIndex = parseInt(draggedItem.getAttribute('data-index'));
  const toIndex = parseInt(this.getAttribute('data-index'));
  
  if (isNaN(fromIndex) || isNaN(toIndex)) return;
  
  // Reorder wallets array
  const [movedWallet] = wallets.splice(fromIndex, 1);
  wallets.splice(toIndex, 0, movedWallet);
  
  // Save the new order to chrome storage
  const walletOrder = wallets.map(w => w.address);
  chrome.storage.sync.set({ wallet_order: walletOrder });
  await updateStorageUsage();

  // Re-render wallets
  renderWallets();
}

// Add event listeners for refresh buttons
document.querySelectorAll('.refresh-btn').forEach(button => {
  button.addEventListener('click', async () => {
    const index = parseInt(button.closest('.wallet-item').dataset.index);
    if (!isNaN(index)) {
      await refreshWallet(index);
    }
  });
});

// Add event listeners for wallet name clicks
document.querySelectorAll('.wallet-text').forEach(element => {
  element.addEventListener('click', async () => {
    const address = element.dataset.address;
    if (address) {
      await copyToClipboard(address);
      showSuccess('Address copied to clipboard!');
    }
  });
});

// Add event listeners for delete buttons
document.querySelectorAll('.delete-btn').forEach(button => {
  button.addEventListener('click', () => {
    const confirmBox = button.nextElementSibling;
    confirmBox.classList.add('show');
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
      confirmBox.classList.remove('show');
    }, 3000);
  });
});

// Add event listeners for delete confirmations
document.querySelectorAll('.confirm-delete').forEach(button => {
  button.addEventListener('click', async () => {
    const index = parseInt(button.closest('.wallet-item').dataset.index);
    if (!isNaN(index)) {
      await deleteWallet(index);
    }
  });
});

// Add event listeners for cancel delete
document.querySelectorAll('.cancel-delete').forEach(button => {
  button.addEventListener('click', () => {
    button.closest('.delete-confirm').classList.remove('show');
  });
});

// Add initialization code for user profile
async function initializeUserProfile() {
  try {
    // Send message to background script to get user info
    const userInfo = await chrome.runtime.sendMessage({ type: 'GET_USER_INFO' });
    if (!userInfo) {
      console.error('No user info available');
      return;
    }

    const userProfile = document.getElementById('userProfile');
    if (userProfile) {
      userProfile.innerHTML = `
        <img src="${userInfo.picture}" alt="Profile" class="profile-pic">
        <span class="user-name">${userInfo.name}</span>
      `;
    }
  } catch (error) {
    console.error('Error initializing user profile:', error);
  }
}

// Add initialization to DOMContentLoaded
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initializeUserProfile();
    await initializePage();
  } catch (error) {
    console.error('Error during initialization:', error);
  }
});

// Try both DOMContentLoaded and window.onload
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded fired');
  setupEventListeners(); // Setup listeners first
  initializePage();
});

window.onload = () => {
  console.log('window.onload fired');
  setupEventListeners(); // Setup listeners again in case DOMContentLoaded missed it
  initializePage();
};

function setupGlobalTabs() {
  const globalTabs = document.querySelectorAll('.global-tab-btn');
  
  globalTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Update active state of global tabs
      globalTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Get all wallet sections
      const walletItems = document.querySelectorAll('.wallet-item');
      
      walletItems.forEach(wallet => {
        // Get all sections in this wallet
        const sections = wallet.querySelectorAll('.wallet-section');
        const buttons = wallet.querySelectorAll('.wallet-nav-button');
        
        // Update sections visibility
        sections.forEach(s => {
          s.classList.toggle('active', s.getAttribute('data-section') === tab.dataset.section);
        });
        
        // Update nav buttons state
        buttons.forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-section') === tab.dataset.section);
        });
      });
    });
  });
};

// Add semicolon after setupGlobalTabs function

// Initialize user profile
async function initializeUserProfile() {
  try {
    // Send message to background script to get user info
    const userInfo = await chrome.runtime.sendMessage({ type: 'GET_USER_INFO' });
    if (!userInfo) {
      console.error('No user info available');
      return;
    }

    const userProfile = document.getElementById('userProfile');
    if (userProfile) {
      userProfile.innerHTML = `
        <img src="${userInfo.picture}" alt="Profile" class="profile-pic">
        <span class="user-name">${userInfo.name}</span>
      `;
    }
  } catch (error) {
    console.error('Error initializing user profile:', error);
  }
}

// Initialize page
async function initializePage() {
  console.log('Initializing modal...');
  initializeModal(); // Initialize modal first
  
  console.log('Loading wallets...');
  // Load wallets and get list of ones needing refresh
  const walletsNeedingRefresh = await loadWallets();
  
  console.log('Rendering wallets...');
  // Render wallets with any cached data we have
  await renderWallets();
  
  // Find all refresh buttons after rendering
  const refreshButtons = document.querySelectorAll('.refresh-btn');
  
  // Only refresh wallets that need it
  if (walletsNeedingRefresh && walletsNeedingRefresh.length > 0) {
    console.log('Refreshing wallets with expired/no cache:', walletsNeedingRefresh);
    
    // Start spinning only buttons for wallets being refreshed
    wallets.forEach((wallet, index) => {
      if (walletsNeedingRefresh.includes(wallet.address)) {
        const button = refreshButtons[index];
        if (button) {
          const icon = button.querySelector('i');
          if (icon) icon.classList.add('rotating');
        }
      }
    });
    
    // Refresh only the wallets that need it
    const refreshResults = await Promise.allSettled(
      wallets.map((wallet, index) => 
        walletsNeedingRefresh.includes(wallet.address) 
          ? refreshWallet(index) 
          : Promise.resolve(false)
      )
    );
    
    // Save and re-render if any wallet was updated successfully
    const hasSuccessfulRefresh = refreshResults.some(result => 
      result.status === 'fulfilled' && result.value === true
    );
    
    if (hasSuccessfulRefresh) {
      await saveWallets();
      await renderWallets();
    }
    
    // Stop all refresh button animations
    refreshButtons.forEach(button => {
      const icon = button.querySelector('i');
      if (icon) icon.classList.remove('rotating');
    });
  } else {
    console.log('All wallets have valid cache, no refresh needed');
  }
  
  // Setup remaining UI elements
  console.log('Setting up UI elements...');
  setupGlobalTabs();
  setupAssetSearch();
  startCacheRefreshMonitor();
  setupTabSwitching();
  
  // Add initial storage update with a small delay to ensure all data is loaded
  setTimeout(async () => {
    await updateStorageUsage();
  }, 1000);
  
  // Add periodic storage update (every 30 seconds)
  setInterval(updateStorageUsage, 30000);
  
  console.log('Initialization complete!');
}

// Add initialization to DOMContentLoaded
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initializeUserProfile();
    await initializePage();
  } catch (error) {
    console.error('Error during initialization:', error);
  }
});
