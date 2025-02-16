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

    // Load wallets
    const tempWallets = {};
    for (const address of walletIndex) {
      try {
        // Load stored metadata first
        const storedData = await new Promise((resolve) => {
          chrome.storage.sync.get(`wallet_${address}`, (result) => {
            resolve(result[`wallet_${address}`] || {});
          });
        });

        // Fetch fresh data
        console.log('Fetching fresh data for wallet:', address);
        const walletData = await fetchWalletData(address);
        console.log('Received wallet data:', walletData);

        // Store wallet data in temporary object
        tempWallets[address] = {
          address,
          name: storedData.name || 'Unnamed Wallet',
          walletType: storedData.walletType || 'None',
          balance: walletData.balance || 0,
          assets: (walletData.assets || []).map(asset => ({
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
          stakingInfo: walletData.stakingInfo
        };
      } catch (error) {
        console.error(`Error loading wallet ${address}:`, error);
        // Add placeholder with stored metadata
        const storedData = await new Promise((resolve) => {
          chrome.storage.sync.get(`wallet_${address}`, (result) => {
            resolve(result[`wallet_${address}`] || {});
          });
        });

        tempWallets[address] = {
          address,
          name: storedData.name || 'Unnamed Wallet',
          walletType: storedData.walletType || 'None',
          balance: 0,
          assets: [],
          error: true
        };
      }
    }

    // Order wallets based on saved order, falling back to wallet_index for any new wallets
    wallets = [];
    
    // First add wallets in saved order
    for (const address of savedOrder) {
      if (tempWallets[address]) {
        wallets.push(tempWallets[address]);
        delete tempWallets[address];
      }
    }
    
    // Then add any remaining wallets that weren't in the saved order
    for (const address of walletIndex) {
      if (tempWallets[address]) {
        wallets.push(tempWallets[address]);
      }
    }

    console.log('Loaded wallets:', wallets);
    await renderWallets();
    await updateStorageUsage();
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
  }
}

async function saveWallets() {
  try {
    // Save wallet index (list of addresses)
    const walletIndex = wallets.map(w => w.address);
    await chrome.storage.sync.set({ wallet_index: walletIndex });

    // Save wallet order
    const walletOrder = wallets.map(w => w.address);
    await chrome.storage.sync.set({ wallet_order: walletOrder });

    // Save only essential metadata for each wallet
    const savePromises = wallets.map(wallet => {
      const metadata = {
        name: wallet.name,
        walletType: wallet.walletType,
        address: wallet.address,
        lastUpdated: Date.now()
      };
      return chrome.storage.sync.set({ [`wallet_${wallet.address}`]: metadata });
    });

    await Promise.all(savePromises);
    await updateStorageUsage();
    return true;
  } catch (error) {
    console.error('Error saving wallets:', error);
    showError('Failed to save wallets');
    return false;
  }
}

async function fetchWalletData(address) {
  try {
    // Check cache first
    const cacheKey = `wallet_data_${address}`;
    const now = Date.now();
    const cache = await chrome.storage.local.get(cacheKey);
    
    // If we have cached data and it's not expired, use it
    if (cache[cacheKey] && now - cache[cacheKey].timestamp < CACHE_DURATION) {
      console.log('Using cached data for', address);
      return cache[cacheKey].data;
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
      balance: data.balance,
      assets: data.assets.map(asset => ({
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
    await chrome.storage.local.set({
      [cacheKey]: {
        data: walletData,
        timestamp: now
      }
    });

    return walletData;

  } catch (error) {
    console.error('Error fetching wallet data:', error);
    // Return empty data structure on error
    return {
      balance: '0',
      assets: [],
      stakingInfo: null,
      error: error.message
    };
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
    const imageUrl = getAssetImage(asset);
    assetThumbnail.innerHTML = imageUrl ? `
      <img src="${imageUrl}" alt="${asset.name || asset.unit}">
    ` : `
      <span style="background-color: ${getRandomColor(asset.name)}">${getFirstLetter(asset.name || asset.unit)}</span>
    `;
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
    if (!wallet) return;

    // Add loading state
    const walletBox = document.querySelector(`[data-index="${index}"]`);
    if (walletBox) {
      walletBox.classList.add('loading');
    }

    // Clear all caches for this wallet
    const walletCacheKey = `wallet_data_${wallet.address}`;
    const assetCachePattern = `asset_${wallet.address}_*`;
    
    // Clear wallet data cache
    await chrome.storage.local.remove(walletCacheKey);
    
    // Clear asset caches
    const storage = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(storage).filter(key => 
      key.startsWith(`asset_${wallet.address}_`) || 
      key.startsWith(`metadata_${wallet.address}_`)
    );
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

    // Fetch data with retry
    let retries = 3;
    let error;
    
    while (retries > 0) {
      try {
        // Fetch wallet data
        const data = await fetchWalletData(wallet.address);
        
        // If we have a stake address, fetch staking info too
        if (data.stake_address) {
          try {
            const stakingInfo = await fetchStakingInfo(data.stake_address);
            data.stakingInfo = stakingInfo;
          } catch (e) {
            console.error('Error fetching staking info:', e);
          }
        }
        
        // Preserve metadata while updating with new data
        Object.assign(wallet, {
          ...data,
          name: wallet.name
        });
        
        await saveWallets();
        await renderWallets();
        return;
      } catch (error) {
        error = error;
        retries--;
        if (retries > 0 && error.message.includes('Too many requests')) {
          await wait(1000 * (3 - retries)); // Exponential backoff
        }
      }
    }
    
    throw error;
  } catch (error) {
    console.error('Error refreshing wallet:', error);
    showError(error.message || 'Failed to refresh wallet');
  } finally {
    // Remove loading state
    const walletBox = document.querySelector(`[data-index="${index}"]`);
    if (walletBox) {
      walletBox.classList.remove('loading');
    }
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

// Listen for messages from background script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RELOAD_WALLETS') {
    console.log('Reloading wallets due to update');
    loadWallets().then(async () => {
      await updateUI();
    });
  }
  else if (message.action === 'walletLoading') {
    // Add loading wallet box immediately
    const wallet = message.wallet;
    const walletContainer = document.getElementById('walletList');
    
    if (walletContainer) {
      const walletBox = document.createElement('div');
      walletBox.className = 'wallet-box loading';
      walletBox.id = `wallet-${wallet.address}`;
      
      // Get icon source - handle custom icons
      let iconSrc = '';
      if (wallet.walletType === 'Custom' && wallet.customIcon) {
        iconSrc = wallet.customIcon;
      } else {
        iconSrc = WALLET_LOGOS[wallet.walletType] || '';
      }
      
      walletBox.innerHTML = `
        <div class="wallet-header">
          <div class="wallet-info">
            ${iconSrc ? `
              <img src="${iconSrc}" alt="${wallet.walletType}" class="wallet-icon">
            ` : ''}
            <div class="wallet-text">
              <div class="wallet-name">${wallet.name}</div>
              <div class="wallet-address">${truncateAddress(wallet.address)}</div>
            </div>
          </div>
        </div>
        <p>Fetching wallet data...</p>
      `;
      
      walletContainer.appendChild(walletBox);
    }
  } 
  else if (message.action === 'walletLoaded') {
    // Update the loading box with complete data
    const wallet = message.wallet;
    const walletBox = document.getElementById(`wallet-${wallet.address}`);
    if (walletBox) {
      createWalletBox(wallet, wallets.findIndex(w => w.address === wallet.address))
        .then(newWalletBox => {
          walletBox.replaceWith(newWalletBox);
        });
    }
  }
  else if (message.action === 'refresh') {
    loadWallets().then(async () => {
      await updateUI();
    });
  }
});

// Modal elements
let modal;
let modalImage;
let modalName;
let modalQuantity;
let modalDescription;
let closeModalButton;

// Modal functions
function showAssetModal(asset) {
  const imageUrl = getAssetImage(asset);
  modalImage.src = imageUrl || 'icons/placeholder.png';
  modalName.textContent = asset.metadata?.name || asset.onchainMetadata?.name || 'Unknown Asset';
  modalQuantity.textContent = `Quantity: ${formatTokenAmount(asset.quantity, asset.decimals)}`;
  modalDescription.textContent = asset.metadata?.description || asset.onchainMetadata?.description || 'No description available';
  modal.style.display = 'block';
}

function hideAssetModal() {
  modal.style.display = 'none';
}

function initializeModal() {
  modal = document.getElementById('asset-modal');
  modalImage = document.getElementById('modal-asset-image');
  modalName = document.getElementById('modal-asset-name');
  modalQuantity = document.getElementById('modal-asset-quantity');
  modalDescription = document.getElementById('modal-asset-description');
  closeModalButton = document.querySelector('.close-modal');

  // Add modal event listeners
  if (closeModalButton) {
    closeModalButton.onclick = hideAssetModal;
  }
  
  window.onclick = (event) => {
    if (event.target === modal) {
      hideAssetModal();
    }
  };
}

// Initial load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    initializeModal();
    await loadWallets();
    setupEventListeners();
  } catch (error) {
    console.error('Error initializing fullview:', error);
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
  
  // Format with proper decimals
  return `₳${adaValue.toLocaleString(undefined, { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 6 
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
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.getAttribute('data-index'));
}

function handleDragEnd(e) {
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
    // Get total bytes in use
    const bytesInUse = await chrome.storage.sync.getBytesInUse();
    
    // Chrome sync storage limit is 5MB (5,242,880 bytes)
    const STORAGE_LIMIT = 5 * 1024 * 1024;
    
    // Calculate percentage used
    const percentageUsed = Math.round((bytesInUse / STORAGE_LIMIT) * 100);
    
    // Update UI
    const storageUsedElement = document.getElementById('storageUsed');
    const storageBarElement = document.getElementById('storageBar');
    
    if (storageUsedElement && storageBarElement) {
      storageUsedElement.textContent = percentageUsed;
      storageBarElement.style.width = `${percentageUsed}%`;
      
      // Update color based on usage
      if (percentageUsed > 90) {
        storageBarElement.style.backgroundColor = '#ff4444';
      } else if (percentageUsed > 70) {
        storageBarElement.style.backgroundColor = '#ffa500';
      } else {
        storageBarElement.style.backgroundColor = '#3498db';
      }
    }
  } catch (error) {
    console.error('Error updating storage usage:', error);
  }
}
