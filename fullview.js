// Import the shared constants and functions
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 5;
const MAX_TOTAL_SLOTS = 500;
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
          } else {
            // Cache exists but is expired
            console.log('Cache expired for', address);
            await chrome.storage.local.remove(cacheKey);
          }
        } else {
          // No cache exists
          console.log('No cache found for', address);
        }

        // Initialize wallet with metadata and any cached data
        tempWallets[address] = {
          address,
          name: storedData.name || 'Unnamed Wallet',
          walletType: storedData.walletType || 'None',
          balance: walletData.balance,
          assets: walletData.assets,
          stakingInfo: walletData.stakingInfo
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
    return walletsNeedingRefresh;
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
    return null;
  }
}

async function saveWallets() {
  try {
    // Save wallet index and order first (these are essential)
    const walletIndex = wallets.map(w => w.address);
    const walletOrder = wallets.map(w => w.address);
    
    await chrome.storage.sync.set({ 
      wallet_index: walletIndex,
      wallet_order: walletOrder 
    });

    // Save metadata for each wallet with longer delay to avoid quota
    for (const wallet of wallets) {
      const metadata = {
        name: wallet.name,
        walletType: wallet.walletType,
        address: wallet.address,
        lastUpdated: Date.now()
      };
      
      try {
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
    showError('Failed to save wallets');
    return false;
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
        decimals: asset.decimals,
        isNFT: isNFT(asset),
        metadata: asset.metadata,
        onchainMetadata: asset.onchainMetadata,
        image: asset.image
      })),
      stakingInfo
    };

    // Cache the fresh data
    const cacheKey = `wallet_data_${address}`;
    await chrome.storage.local.set({
      [cacheKey]: {
        data: walletData,
        timestamp: Date.now()
      }
    });

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
    }
  } catch (error) {
    console.error('Error cleaning up cache:', error);
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
  updateSlotCount();
}

async function createWalletBox(wallet, index) {
  const box = document.createElement('div');
  box.className = 'wallet-item';
  box.setAttribute('draggable', 'true');
  box.setAttribute('data-index', index);

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
  if (walletType === 'Custom') {
    const data = await chrome.storage.local.get(`wallet_icon_${wallet.address}`);
    iconSrc = data[`wallet_icon_${wallet.address}`] || WALLET_LOGOS['None'];
  } else {
    iconSrc = WALLET_LOGOS[walletType] || WALLET_LOGOS['None'];
  }

  header.innerHTML = `
    <div class="wallet-info">
      ${iconSrc ? `
        <img src="${iconSrc}" alt="${walletType}" class="wallet-icon">
      ` : ''}
      <div class="wallet-text" role="button" title="Click to copy address">
        <div class="wallet-name">${wallet.name || 'Unnamed Wallet'}</div>
        <div class="wallet-address">${truncateAddress(wallet.address || '')}</div>
      </div>
    </div>
    <button class="delete-btn" title="Delete">×</button>
  `;

  // Add click handler for wallet info
  const walletText = header.querySelector('.wallet-text');
  const walletName = walletText.querySelector('.wallet-name');
  walletText.addEventListener('click', async () => {
    await copyToClipboard(wallet.address);
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
      if (confirm('Are you sure you want to delete this wallet?')) {
          deleteWallet(index);
      }
  });

  // Create content sections
  const contentContainer = document.createElement('div');
  contentContainer.className = 'wallet-content';

  // General section
  const generalSection = document.createElement('div');
  generalSection.className = 'wallet-section active';
  generalSection.setAttribute('data-section', 'general');
  generalSection.innerHTML = `
    <div class="balance-group">
      <div class="balance-label">Balance:</div>
      <div class="balance-value">${formatBalance(wallet.balance)}</div>
    </div>
    <div class="action-buttons">
      <button class="action-button refresh-btn" title="Refresh">
        <i class="fas fa-sync-alt"></i>
      </button>
    </div>
  `;

  // Add event listeners for action buttons
  const refreshBtn = generalSection.querySelector('.refresh-btn');
  refreshBtn.addEventListener('click', () => refreshWallet(index));

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
      
      // Render assets for the selected tab
      renderAssetsList(currentWallet, btn.dataset.filter);
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
    const formattedRewards = (parseInt(rewards) / 1000000).toFixed(2);
    
    stakingSection.innerHTML = `
      <div class="staking-info">
        <div class="staking-group">
          <div class="staking-label">Pool</div>
          <div class="staking-value">${wallet.stakingInfo.pool_info.metadata?.ticker || 'Unknown'}</div>
        </div>
        <div class="staking-group">
          <div class="staking-label">Rewards</div>
          <div class="staking-value">${formattedRewards} ₳</div>
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
  
  box.appendChild(header);
  box.appendChild(contentContainer);
  box.appendChild(nav);
  
  // Add navigation event listeners
  nav.querySelectorAll('.wallet-nav-button').forEach(button => {
    button.addEventListener('click', () => {
      // Update active button
      nav.querySelectorAll('.wallet-nav-button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      
      // Update active section
      const sectionName = button.getAttribute('data-section');
      contentContainer.querySelectorAll('.wallet-section').forEach(section => {
        section.classList.toggle('active', section.getAttribute('data-section') === sectionName);
      });
    });
  });
  
  return box;
}

async function fetchStakingInfo(stakeAddress) {
  try {
    console.log('Fetching staking info for stake address:', stakeAddress);
    
    // First get account info
    const response = await fetch(`${API_BASE_URL}/api/accounts/${stakeAddress}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': chrome.runtime.getURL('')
      }
    });
    
    if (!response.ok) throw new Error('Failed to fetch staking info');
    
    const data = await response.json();
    console.log('Staking data received:', data);
    
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
  for (let i = 0; i <text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % COLORS.length;
  return COLORS[hue]; // Consistent but random-looking color
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

async function addWallet() {
  try {
    if (wallets.length >= unlockedSlots) {
      showError(`You've reached the maximum number of free slots (${MAX_FREE_SLOTS}). Purchase more slots to add more wallets.`);
      return;
    }

    const addressInput = document.getElementById('walletAddress');
    const nameInput = document.getElementById('walletName');
    const typeSelect = document.getElementById('walletType');

    if (!addressInput || !nameInput || !typeSelect) {
      showError('Required input elements not found');
      return;
    }

    const address = addressInput.value.trim();
    const name = nameInput.value.trim() || 'Unnamed Wallet';
    const walletType = address.startsWith('$') ? 'Vesper' : 'None';

    if (!address) {
      showError('Please enter a wallet address');
      return;
    }

    // Check if wallet already exists
    if (wallets.some(w => w.address === address)) {
      showError('This wallet has already been added');
      return;
    }

    // Create new wallet object
    const newWallet = {
      address,
      name,
      walletType,
      balance: 0,
      assets: []
    };

    // Add to wallets array
    wallets.push(newWallet);

    // Save to storage
    await saveWallets();

    // Clear inputs
    addressInput.value = '';
    nameInput.value = '';
    typeSelect.value = 'None';

    // Refresh UI
    await renderWallets();
    
    // Start loading wallet data
    refreshWallet(wallets.length - 1);

    showSuccess('Wallet added successfully!');
  } catch (error) {
    console.error('Error adding wallet:', error);
    showError('Failed to add wallet');
  }
}

async function updateUI() {
  await renderWallets();
  await updateStorageUsage();
  setupEventListeners();
}

function needsRefresh(wallet) {
  if (!wallet.lastUpdated) return true;
  const fiveMinutes = 5 * 60 * 1000;
  return Date.now() - wallet.lastUpdated > fiveMinutes;
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
      name: wallet.name, // Preserve name
      walletType: wallet.walletType, // Preserve type
      lastUpdated: Date.now() // Add timestamp
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
          max-width: 100%;
          max-height: 50vh;
          object-fit: contain;
          border-radius: 8px;
        `;
        imageContainer.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
          width: 150px;
          height: 150px;
          background-color: ${getRandomColor(asset.name)};
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 48px;
          color: white;
        `;
        placeholder.textContent = getFirstLetter(asset.name || asset.unit);
        imageContainer.appendChild(placeholder);
      }

      // Format the asset information
      const quantity = formatTokenQuantity(asset.quantity, asset.decimals);
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
              <div style="word-break: break-all">${asset.fingerprint}</div>
            </div>
          ` : ''}
          
          <div>
            <div style="color: var(--text-secondary); font-size: 12px;">Asset ID</div>
            <div style="word-break: break-all">${asset.unit}</div>
          </div>
          
          ${asset.policy ? `
            <div>
              <div style="color: var(--text-secondary); font-size: 12px;">Policy ID</div>
              <div style="word-break: break-all">${asset.policy}</div>
            </div>
          ` : ''}
        </div>
        
        ${asset.description ? `
          <div style="margin-top: 15px; color: var(--text-secondary);">
            ${asset.description}
          </div>
        ` : ''}
      `;

      modalOverlay.style.display = 'flex';
    }
  };
}

// Add this helper function for formatting token quantities
function formatTokenQuantity(quantity, decimals = 0) {
  try {
    if (!quantity) return '0';
    
    // Convert to BigInt for precise handling
    const bigQuantity = BigInt(quantity);
    
    // If no decimals or quantity is 1 (NFT), return as is
    if (decimals === 0 || quantity === '1') {
      return bigQuantity.toLocaleString();
    }
    
    // Calculate divisor (e.g., for 6 decimals: 1000000)
    const divisor = BigInt(10 ** decimals);
    
    // Get whole and decimal parts
    const wholePart = (bigQuantity / divisor).toString();
    const decimalPart = (bigQuantity % divisor).toString().padStart(decimals, '0');
    
    // Trim trailing zeros in decimal part
    const trimmedDecimal = decimalPart.replace(/0+$/, '');
    
    // Format whole part with commas
    const formattedWhole = BigInt(wholePart).toLocaleString();
    
    // Return formatted number
    return trimmedDecimal 
      ? `${formattedWhole}.${trimmedDecimal}`
      : formattedWhole;
  } catch (error) {
    console.error('Error formatting token quantity:', error);
    return quantity;
  }
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
  
  modalImage.src = asset.image || 'icons/placeholder.png';
  modalName.textContent = asset.name || 'Unnamed Asset';
  modalAmount.textContent = `Amount: ${formatTokenAmount(asset.quantity, asset.decimals)}`;
  modalPolicy.textContent = `Policy ID: ${asset.policy_id || 'N/A'}`;
  modal.style.display = 'block';
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
  amount.textContent = formatTokenAmount(asset.quantity, asset.decimals);
  
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
document.addEventListener('DOMContentLoaded', async () => {
  try {
    initializeModal(); // Initialize modal first
    
    // Load wallets and get list of ones needing refresh
    const walletsNeedingRefresh = await loadWallets();
    if (walletsNeedingRefresh === null) return;
    
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
      
      // Save and render if any wallet was updated
      if (refreshResults.some(result => result)) {
        await saveWallets();
        await renderWallets();
      }
    } else {
      console.log('All wallets have valid cache, no refresh needed');
    }
    
    // Setup remaining UI elements
    setupEventListeners();
    setupAssetsPanelListeners();
    updateUI();
    updateStorageUsage();

    // Start the cache refresh monitor
    const CACHE_CHECK_INTERVAL = 30000; // Check cache every 30 seconds
    const CACHE_REFRESH_THRESHOLD = 60000; // Refresh if less than 1 minute left
    async function startCacheRefreshMonitor() {
      setInterval(async () => {
        try {
          // Skip if no wallets
          if (!wallets || wallets.length === 0) return;

          const now = Date.now();
          const walletsToRefresh = [];

          // Check each wallet's cache
          for (const [index, wallet] of wallets.entries()) {
            const cacheKey = `wallet_data_${wallet.address}`;
            const cache = await chrome.storage.local.get(cacheKey);

            if (cache[cacheKey]) {
              const timeLeft = (cache[cacheKey].timestamp + CACHE_DURATION) - now;
              
              // If cache will expire soon, add to refresh list
              if (timeLeft <= CACHE_REFRESH_THRESHOLD) {
                console.log(`Cache expiring soon for wallet ${wallet.address}, scheduling refresh`);
                walletsToRefresh.push(index);
              }
            }
          }

          // Refresh wallets that need it
          if (walletsToRefresh.length > 0) {
            console.log('Auto-refreshing wallets with expiring cache:', walletsToRefresh);
            
            // Start refresh animations
            walletsToRefresh.forEach(index => {
              const button = document.querySelector(`[data-index="${index}"] .refresh-btn i`);
              if (button) button.classList.add('rotating');
            });

            // Refresh all expiring wallets in parallel
            const refreshResults = await Promise.all(
              walletsToRefresh.map(index => refreshWallet(index))
            );

            // If any wallet was updated, save and re-render
            if (refreshResults.some(result => result)) {
              await saveWallets();
              await renderWallets();
            }
          }
        } catch (error) {
          console.error('Error in cache refresh monitor:', error);
        }
      }, CACHE_CHECK_INTERVAL);
    }
    startCacheRefreshMonitor();
  } catch (error) {
    console.error('Error during initial load:', error);
    showError('Failed to load wallets');
  }
});

// Buy slots button handler
document.getElementById('buySlots').addEventListener('click', async () => {
  try {
    // Show confirmation modal
    const modal = createModal(`
      <div class="modal-content">
        <div class="modal-header">
          <h2>Buy More Slots</h2>
        </div>
        <div class="payment-details">
          <div class="amount-display">
            ${BONE_PAYMENT_AMOUNT} BONE
          </div>
          <p>Get ${SLOTS_PER_PAYMENT} additional wallet slots</p>
        </div>
        <div class="modal-buttons">
          <button class="modal-button secondary">Cancel</button>
          <button class="modal-button primary">Proceed to Payment</button>
        </div>
      </div>
    `);
    
    document.body.appendChild(modal);
    
    // Handle cancel button
    const cancelButton = modal.querySelector('.secondary');
    if (cancelButton) {
      cancelButton.addEventListener('click', () => {
        modal.remove();
      });
    }
    
    // Handle proceed button
    const proceedButton = modal.querySelector('.primary');
    if (proceedButton) {
      proceedButton.addEventListener('click', async () => {
        modal.remove();
        await initiatePayment();
      });
    }
  } catch (error) {
    console.error('Error handling buy slots:', error);
    showError('Failed to show payment modal');
  }
});

async function initiatePayment() {
  try {
    // Get extension's installation ID
    const installId = chrome.runtime.id;
    
    // Get payment details from server
    const response = await fetch(`${API_BASE_URL}/api/initiate-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        installId
      })
    });

    if (!response.ok) throw new Error('Failed to initiate payment');
    const { paymentId, address } = await response.json();
    
    // Show payment details modal
    const modal = createModal(`
      <div class="modal-content">
        <div class="modal-header">
          <h2>Buy More Slots</h2>
          <div class="payment-status">Waiting for payment...</div>
        </div>
        
        <div class="payment-details">
          <div class="amount-display">
            ${BONE_PAYMENT_AMOUNT} BONE
          </div>
          
          <div class="address-container">
            <span class="label">Send to:</span>
            <div class="address-box">${address}</div>
          </div>
        </div>

        <div class="modal-buttons">
          <button class="modal-button secondary">Cancel</button>
          <button class="modal-button primary">Check Status</button>
        </div>
      </div>
    `);

    document.body.appendChild(modal);

    // Add button handlers
    const cancelButton = modal.querySelector('.modal-button.secondary');
    const checkButton = modal.querySelector('.modal-button.primary');

    cancelButton.addEventListener('click', () => {
      modal.remove();
    });

    checkButton.addEventListener('click', async () => {
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

          showSuccess('Payment verified! Your slots have been added.');
          
          // Close modal after 2 seconds
          setTimeout(() => {
            modal.remove();
            updateUI();
          }, 2000);
        } else {
          statusDiv.textContent = 'Payment not detected yet. Try again in a few moments.';
        }
      } catch (error) {
        console.error('Error checking payment:', error);
        statusDiv.textContent = 'Error checking payment status';
      }
    });

    // Start polling for payment status
    pollPaymentStatus(paymentId, modal);

  } catch (error) {
    console.error('Payment initiation error:', error);
    showError('Failed to initiate payment. Please try again.');
  }
}

function formatBalance(balance) {
  // Convert null/undefined to 0
  const rawBalance = balance || 0;
  
  // Convert from lovelace to ADA (1 ADA = 1,000,000 lovelace)
  const adaValue = parseFloat(rawBalance) / 1000000;
  
  // Format with 2 decimal places
  return `₳${adaValue.toLocaleString(undefined, { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 2 
  })}`;
}

function formatTokenAmount(amount, decimals = 0) {
  if (!amount) return '0';
  
  const value = parseFloat(amount) / Math.pow(10, decimals);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  });
}

function updateSlotCount() {
  const slotCountElement = document.getElementById('slotCount');
  if (slotCountElement) {
    const { length } = wallets;
    slotCountElement.textContent = `${length}/${unlockedSlots}`;
  }
}

function createModal(html) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
  modal.innerHTML = html;
  return modal;
}

function pollPaymentStatus(paymentId, modal) {
  let attempts = 0;
  const maxAttempts = 36; // 3 minutes total with increasing intervals
  
  const checkStatus = async () => {
    attempts++;
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
    if (!response.ok) throw new Error('Failed to verify payment');
    const { verified, used } = await response.json();

    if (verified) {
      if (used) {
        showError('This payment has already been used.');
        modal.remove();
        return true;
      }

      // Update status and add slots
      const statusDiv = modal.querySelector('.payment-status');
      if (statusDiv) {
        statusDiv.textContent = 'Payment verified!';
        statusDiv.className = 'payment-status success';
      }
      
      const { availableSlots } = await chrome.storage.local.get('availableSlots');
      await chrome.storage.local.set({
        availableSlots: (availableSlots || MAX_FREE_SLOTS) + SLOTS_PER_PAYMENT
      });

      showSuccess('Payment verified! Your slots have been added.');
      
      // Close modal after 2 seconds
      setTimeout(() => {
        modal.remove();
        updateUI();
      }, 2000);
      
      return true;
    }
    
    if (attempts >= maxAttempts) {
      const statusDiv = modal.querySelector('.payment-status');
      if (statusDiv) {
        statusDiv.textContent = 'Verification timeout';
        statusDiv.className = 'payment-status error';
      }
      return true;
    }
    
    // Calculate next delay with exponential backoff
    const nextDelay = Math.min(2000 * Math.pow(1.2, attempts), 10000); // Cap at 10 seconds
    setTimeout(checkStatus, nextDelay);
    
    return false;
  };
  
  checkStatus();
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

function handleDrop(e) {
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
  
  // Re-render wallets
  renderWallets();
}

// Wallet management functions
async function deleteWallet(index) {
  try {
    const walletToDelete = wallets[index];
    if (!walletToDelete) {
      throw new Error('Wallet not found');
    }

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
    
    showSuccess('Wallet deleted successfully');
  } catch (error) {
    console.error('Error deleting wallet:', error);
    showError('Failed to delete wallet');
  }
}

// Setup event listeners
function setupEventListeners() {
  // Add refresh button listeners
  document.querySelectorAll('.refresh-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const index = parseInt(button.closest('.wallet-item').dataset.index);
      if (!isNaN(index)) {
        await refreshWallet(index);
      }
    });
  });

  // Add wallet name click listeners for copying address
  document.querySelectorAll('.wallet-text').forEach(element => {
    element.addEventListener('click', async () => {
      const walletItem = element.closest('.wallet-item');
      const address = walletItem.dataset.address;
      if (address) {
        await copyToClipboard(address);
        const walletType = element.querySelector('.wallet-type');
        const originalText = walletType.innerText;
        walletType.innerText = 'Copied!';
        walletType.style.color = '#00b894';
        setTimeout(() => {
          walletType.innerText = originalText;
          walletType.style.color = '';
        }, 1000);
      }
    });
  });

  // Add navigation button listeners
  document.querySelectorAll('.wallet-nav-button').forEach(button => {
    button.addEventListener('click', () => {
      const walletItem = button.closest('.wallet-item');
      const sectionName = button.dataset.section;
      
      // Update active button
      walletItem.querySelectorAll('.wallet-nav-button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      
      // Update active section
      walletItem.querySelectorAll('.wallet-section').forEach(section => {
        section.classList.toggle('active', section.getAttribute('data-section') === sectionName);
      });
    });
  });
}

async function updateStorageUsage() {
  try {
    // First get all stored data to analyze
    const allData = await chrome.storage.sync.get(null);
    console.log('All stored data:', allData);
    
    // Calculate total size manually since getBytesInUse might not be reliable
    let totalSize = 0;
    for (const key in allData) {
      // Skip any undefined or invalid keys
      if (key === 'wallet_undefined' || key === 'undefined') {
        // Clean up invalid data
        chrome.storage.sync.remove(key);
        continue;
      }
      
      const value = allData[key];
      if (value === null || value === undefined) {
        chrome.storage.sync.remove(key);
        continue;
      }
      
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      console.log(`Size of ${key}: ${size} bytes (${JSON.stringify(value).length} chars)`);
      totalSize += size;
    }
    console.log('Calculated total size:', totalSize, 'bytes');
    
    // Chrome sync storage limit is 5MB (5,242,880 bytes)
    const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB
    console.log('Storage limit:', STORAGE_LIMIT);
    
    // Calculate percentage used (use 2 decimal places)
    const percentageUsed = Math.max(0.01, (totalSize / STORAGE_LIMIT) * 100);
    const roundedPercentage = Math.round(percentageUsed * 100) / 100;
    console.log('Storage percentage used:', roundedPercentage);
    
    // Update UI
    const storageUsedElement = document.getElementById('storageUsed');
    const storageBarElement = document.getElementById('storageBar');
    
    if (storageUsedElement && storageBarElement) {
      console.log('Updating storage UI elements');
      storageUsedElement.textContent = roundedPercentage.toFixed(2);
      storageBarElement.style.width = `${roundedPercentage}%`;
      
      // Update color based on usage
      if (roundedPercentage > 90) {
        storageBarElement.style.backgroundColor = '#ff4444';
      } else if (roundedPercentage > 70) {
        storageBarElement.style.backgroundColor = '#ffa500';
      } else {
        storageBarElement.style.backgroundColor = '#3498db';
      }
    } else {
      console.warn('Storage UI elements not found:', {
        storageUsedElement: !!storageUsedElement,
        storageBarElement: !!storageBarElement
      });
    }

    // Also clean up duplicate data
    if (allData.wallet_index && allData.wallet_order && 
        JSON.stringify(allData.wallet_index) === JSON.stringify(allData.wallet_order)) {
      // If they're identical, we can remove wallet_order and just use index
      chrome.storage.sync.remove('wallet_order');
    }

    // Log Chrome storage limits
    console.log('Chrome storage limits:', {
      QUOTA_BYTES: chrome.storage.sync.QUOTA_BYTES,
      QUOTA_BYTES_PER_ITEM: chrome.storage.sync.QUOTA_BYTES_PER_ITEM,
      MAX_ITEMS: chrome.storage.sync.MAX_ITEMS,
      MAX_WRITE_OPERATIONS_PER_HOUR: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_HOUR,
      MAX_WRITE_OPERATIONS_PER_MINUTE: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE
    });
  } catch (error) {
    console.error('Error updating storage usage:', error);
  }
}

// Rate limiting
const API_DELAY = 500; // ms between requests
let lastRequestTime = 0;

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
