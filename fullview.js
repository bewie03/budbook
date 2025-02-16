// Import the shared constants and functions
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 5;
const MAX_TOTAL_SLOTS = 100;
const BONE_PAYMENT_AMOUNT = 100;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';
const BONE_POLICY_ID = ''; // Add your BONE token policy ID here
const BONE_ASSET_NAME = ''; // Add your BONE token asset name here

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

const CURRENCIES = {
  'ADA': { symbol: '₳', rate: 1 },
  'USD': { symbol: '$', rate: 0 },
  'EUR': { symbol: '€', rate: 0 },
  'GBP': { symbol: '£', rate: 0 }
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
    const data = await chrome.storage.sync.get(['wallet_index', 'unlockedSlots', 'slots_version']);
    const walletIndex = data.wallet_index || [];
    
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

    // Load wallets sequentially
    wallets = [];
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

        // Merge stored metadata with fresh data, ensuring walletType is preserved
        wallets.push({
          ...walletData,
          name: storedData.name || 'Unnamed Wallet',
          walletType: storedData.walletType || 'None',
          address
        });
      } catch (error) {
        console.error(`Error loading wallet ${address}:`, error);
        // Add placeholder with stored metadata
        const storedData = await new Promise((resolve) => {
          chrome.storage.sync.get(`wallet_${address}`, (result) => {
            resolve(result[`wallet_${address}`] || {});
          });
        });

        wallets.push({
          address,
          name: storedData.name || 'Unnamed Wallet',
          walletType: storedData.walletType || 'None',
          error: error.message,
          balance: 0,
          assets: []
        });
      }
    }

    console.log('Loaded wallets:', wallets);
    renderWallets();
  } catch (error) {
    console.error('Error loading wallets:', error);
    showError('Failed to load wallets');
  }
}

async function saveWallets() {
  try {
    // Create a wallet index (just addresses)
    const walletIndex = wallets.map(w => w.address);
    
    // Save wallet index
    await chrome.storage.sync.set({ wallet_index: walletIndex });
    
    // Save individual wallet metadata
    const savePromises = wallets.map(wallet => {
      const metadata = {
        name: wallet.name,
        walletType: wallet.walletType,
        address: wallet.address
      };
      return chrome.storage.sync.set({ [`wallet_${wallet.address}`]: metadata });
    });
    
    await Promise.all(savePromises);
    
    // Save unlocked slots
    await chrome.storage.sync.set({ unlockedSlots });
  } catch (error) {
    console.error('Error saving wallets:', error);
    showError('Failed to save wallet data');
  }
}

async function fetchWalletData(address) {
  try {
    // Check cache first
    const cacheKey = `wallet_data_${address}`;
    const cachedData = await chrome.storage.local.get(cacheKey);
    const cached = cachedData[cacheKey];

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Using cached data for:', address);
      return cached.data;
    }

    console.log('Fetching data for address:', address);
    const data = await requestQueue.add({
      url: `${API_BASE_URL}/api/wallet/${address}`,
      options: {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': chrome.runtime.getURL('')
        }
      }
    });

    // Get staking info if stake_address is available
    if (data.stake_address) {
      try {
        data.stakingInfo = await fetchStakingInfo(data.stake_address);
      } catch (error) {
        console.error('Error fetching staking info:', error);
        data.stakingInfo = { error: 'Failed to load staking info', stake_address: data.stake_address };
      }
    }

    // Cache the results
    await chrome.storage.local.set({
      [cacheKey]: {
        data,
        timestamp: Date.now()
      }
    });

    return data;
  } catch (error) {
    console.error('Error in fetchWalletData:', error);
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
  
  // Helper to check and convert URL
  const processUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
      // Clean the URL first
      url = url.trim();
      if (!url) return null;
      
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

function renderWallets() {
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
    wallets.forEach((wallet, index) => {
      if (!wallet) return; // Skip if wallet is undefined
      
      const walletBox = createWalletBox(wallet, index);
      walletList.appendChild(walletBox);
    });
  }

  // Update slot count after rendering wallets
  updateSlotCount();
}

function createWalletBox(wallet, index) {
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
  const iconPath = WALLET_LOGOS[wallet.walletType] || WALLET_LOGOS['None'];
  
  header.innerHTML = `
    <div class="wallet-info">
      ${iconPath ? `
        <img src="${iconPath}" alt="${wallet.walletType}" class="wallet-icon">
      ` : ''}
      <div class="wallet-text" role="button" title="Click to copy address">
        <div class="wallet-name">${wallet.name || 'Unnamed Wallet'}</div>
        <div class="wallet-type">${wallet.walletType || 'None'}</div>
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
  stakingSection.appendChild(createStakingPanel(wallet));

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

function createStakingPanel(wallet) {
  console.log('Creating staking panel with wallet:', wallet);
  const panel = document.createElement('div');
  panel.className = 'staking-panel';

  if (!wallet.stakingInfo) {
    console.log('No staking info available');
    panel.innerHTML = `
      <div class="staking-info">
        <p class="stake-status">Loading staking info...</p>
      </div>
    `;
    return panel;
  }

  console.log('Staking info available:', wallet.stakingInfo);

  // Handle error case
  if (wallet.stakingInfo.error) {
    panel.innerHTML = `
      <div class="staking-info">
        <p class="stake-status error-text">Error: ${wallet.stakingInfo.error}</p>
        ${wallet.stakingInfo.stake_address ? `
          <div class="stake-address clickable" data-address="${wallet.stakingInfo.stake_address}">
            ${truncateAddress(wallet.stakingInfo.stake_address, 8, 8)}
          </div>
        ` : ''}
      </div>
    `;
    return panel;
  }

  // Handle unstaked case
  if (!wallet.stakingInfo.active) {
    panel.innerHTML = `
      <div class="staking-info">
        <p class="stake-status">Unstaked</p>
        ${wallet.stakingInfo.stake_address ? `
          <div class="stake-address clickable" data-address="${wallet.stakingInfo.stake_address}">
            ${truncateAddress(wallet.stakingInfo.stake_address, 8, 8)}
          </div>
        ` : ''}
      </div>
    `;

    if (wallet.stakingInfo.stake_address) {
      const addressDiv = panel.querySelector('.stake-address');
      addressDiv.addEventListener('click', async function() {
        await copyToClipboard(this.dataset.address);
        const originalText = this.innerText;
        this.innerText = 'Copied!';
        setTimeout(() => {
          this.innerText = originalText;
        }, 1000);
      });
    }

    return panel;
  }

  // Handle staked case
  panel.innerHTML = `
    <div class="staking-info">
      <div class="stake-stats">
        <div class="stat-item">
          <span class="label">Pool:</span>
          <span class="pool-ticker">${wallet.stakingInfo.ticker || 'Unknown Pool'}</span>
        </div>
        <div class="stat-item">
          <span class="label">Rewards:</span>
          <span class="rewards-value">${wallet.stakingInfo.rewards === 'Error' ? 'Error loading' : formatBalance(wallet.stakingInfo.rewards || '0')}</span>
        </div>
      </div>
      ${wallet.stakingInfo.stake_address ? `
        <div class="stake-address clickable" data-address="${wallet.stakingInfo.stake_address}">
          ${truncateAddress(wallet.stakingInfo.stake_address, 8, 8)}
        </div>
      ` : ''}
    </div>
  `;

  if (wallet.stakingInfo.stake_address) {
    const addressDiv = panel.querySelector('.stake-address');
    addressDiv.addEventListener('click', async function() {
      await copyToClipboard(this.dataset.address);
      const originalText = this.innerText;
      this.innerText = 'Copied!';
      setTimeout(() => {
        this.innerText = originalText;
      }, 1000);
    });
  }

  return panel;
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
      
      // Update active tab button
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
    const walletType = typeSelect.value;

    if (!address) {
      showError('Please enter a wallet address');
      return;
    }

    // Check if wallet already exists
    if (wallets.some(w => w.address === address)) {
      showError('This wallet has already been added');
      return;
    }

    // Create new wallet with metadata
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
    renderWallets();
    
    // Start loading wallet data
    refreshWallet(wallets.length - 1);

    showSuccess('Wallet added successfully!');
  } catch (error) {
    console.error('Error adding wallet:', error);
    showError('Failed to add wallet');
  }
}

function updateUI() {
  renderWallets();
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

    // Fetch data with retry
    let retries = 3;
    let error;
    
    while (retries > 0) {
      try {
        const data = await fetchWalletData(wallet.address);
        // Preserve metadata while updating with new data
        Object.assign(wallet, {
          ...data,
          name: wallet.name,
          walletType: wallet.walletType
        });
        await saveWallets();
        renderWallets();
        return;
      } catch (e) {
        error = e;
        retries--;
        if (retries > 0 && e.message.includes('Too many requests')) {
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

// Listen for reload messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RELOAD_WALLETS') {
    console.log('Reloading wallets due to storage change');
    loadWallets().then(() => {
      updateUI();
    });
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'walletLoading') {
    // Add loading wallet box immediately
    const wallet = message.wallet;
    const walletContainer = document.getElementById('walletContainer');
    
    const walletBox = document.createElement('div');
    walletBox.className = 'wallet-box loading';
    walletBox.id = `wallet-${wallet.address}`;
    
    walletBox.innerHTML = `
      <div class="wallet-header">
        <h3>${wallet.name}</h3>
        <div class="wallet-type">
          ${wallet.walletType !== 'None' ? `<img src="${WALLET_LOGOS[wallet.walletType]}" alt="${wallet.walletType}">` : ''}
        </div>
      </div>
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <p>Fetching wallet data...</p>
      </div>
    `;
    
    walletContainer.appendChild(walletBox);
  } 
  else if (message.action === 'walletLoaded') {
    // Update the loading box with complete data
    const wallet = message.wallet;
    const walletBox = document.getElementById(`wallet-${wallet.address}`);
    if (walletBox) {
      walletBox.className = 'wallet-box';
      createWalletBox(wallet, wallets.findIndex(w => w.address === wallet.address));
    }
  }
  else if (message.action === 'refresh') {
    loadWallets().then(() => {
      updateUI();
    });
  }
});

// Initialize everything when the page loads
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('Initializing fullview page...');
    await loadWallets();
    await setupEventListeners();
    console.log('Initialization complete');
  } catch (error) {
    console.error('Error initializing fullview:', error);
    showError('Failed to initialize the page. Please refresh.');
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

// Polling fallback function
async function pollPaymentStatus(paymentId, modal) {
  let attempts = 0;
  const maxAttempts = 36; // 3 minutes total with increasing intervals
  
  const checkStatus = async () => {
    attempts++;
    const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentId}`);
    if (!response.ok) throw new Error('Failed to verify payment');
    const { verified, used } = await response.json();
    
    if (verified) {
      if (used) {
        showError('This payment has already been used to add slots.');
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

async function setupEventListeners() {
  // Add refresh button listeners
  document.querySelectorAll('.refresh-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const index = parseInt(button.dataset.index);
      if (!isNaN(index)) {
        await refreshWallet(index);
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
      const tabType = button.dataset.tab;
      
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

  // Load saved currency preference
  chrome.storage.local.get('selectedCurrency', (data) => {
    if (data.selectedCurrency) {
      selectedCurrency = data.selectedCurrency;
      renderWallets();
    }
  });

  // Update exchange rates periodically
  // updateExchangeRates();
  // setInterval(updateExchangeRates, 5 * 60 * 1000); // Update every 5 minutes
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
    
    // Update indices
    wallets.forEach((wallet, index) => {
        wallet.index = index;
    });
    
    // Save the new order
    await chrome.storage.local.set({ wallets });
    
    // Re-render wallets
    renderWallets();
}

// Asset loading and caching
const ASSETS_PER_PAGE = 12; // Load 12 assets at a time
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function loadAssetsInBatches(wallet, startIndex = 0) {
  try {
    // Check cache first
    const cacheKey = `assets_${wallet.address}`;
    const cachedData = await chrome.storage.local.get(cacheKey);
    const cached = cachedData[cacheKey];

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.assets;
    }

    // Load initial batch
    const assets = wallet.assets || [];
    const batch = assets.slice(startIndex, startIndex + ASSETS_PER_PAGE);
    
    // Load metadata for the batch
    const loadedBatch = await Promise.all(
      batch.map(async (asset) => {
        const metadata = await getAssetFromCache(asset.unit);
        return { ...asset, metadata };
      })
    );

    // Update the assets array
    assets.splice(startIndex, loadedBatch.length, ...loadedBatch);

    // Cache the results
    await chrome.storage.local.set({
      [cacheKey]: {
        assets,
        timestamp: Date.now()
      }
    });

    return assets;
  } catch (error) {
    console.error('Error loading assets:', error);
    return [];
  }
}

function createAssetGrid(assets, type = 'token') {
  const container = document.createElement('div');
  container.className = `assets-grid ${type}`;
  
  // Create intersection observer for lazy loading
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          observer.unobserve(img);
        }
      }
    });
  });

  // Add scroll listener for infinite loading
  let loading = false;
  container.addEventListener('scroll', async () => {
    if (loading) return;
    
    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      loading = true;
      const currentCount = container.children.length;
      const wallet = wallets.find(w => w.address === container.dataset.address);
      
      if (wallet && currentCount < wallet.assets.length) {
        const newAssets = await loadAssetsInBatches(wallet, currentCount);
        appendAssetsToGrid(newAssets.slice(currentCount), container, type, observer);
      }
      loading = false;
    }
  });

  return { container, observer };
}

function appendAssetsToGrid(assets, container, type, observer) {
  assets.forEach(asset => {
    const isNFTAsset = isNFT(asset);
    if ((type === 'nft' && !isNFTAsset) || (type === 'token' && isNFTAsset)) {
      return;
    }

    const card = document.createElement('div');
    card.className = 'asset-card';
    
    // Handle NFT/token images
    const imageUrl = getAssetImage(asset);
    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'asset-image';
      img.dataset.src = imageUrl;
      img.src = 'icons/placeholder.png'; // Add a placeholder image
      
      // Handle image loading errors
      img.onerror = function() {
        // Try next IPFS gateway if it's an IPFS URL
        if (this.src.includes('/ipfs/')) {
          const currentGateway = IPFS_GATEWAYS.find(g => this.src.includes(g));
          if (currentGateway) {
            const hash = this.src.split(currentGateway)[1];
            const nextGatewayIndex = (IPFS_GATEWAYS.indexOf(currentGateway) + 1) % IPFS_GATEWAYS.length;
            this.src = `${IPFS_GATEWAYS[nextGatewayIndex]}${hash}`;
            return;
          }
        }
        // If all gateways fail or it's not an IPFS URL, show fallback
        this.src = 'icons/image-error.png';
        this.classList.add('image-error');
      };
      
      observer.observe(img);
      card.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'asset-info';
    info.innerHTML = `
      <div class="asset-name">${asset.metadata?.name || asset.onchainMetadata?.name || 'Unknown Asset'}</div>
      <div class="asset-amount">${formatTokenAmount(asset.quantity, asset.decimals)}</div>
    `;
    
    card.appendChild(info);
    container.appendChild(card);
  });
}

function createAssetsPanel(wallet) {
  const panel = document.createElement('div');
  panel.className = 'assets-panel';
  panel.dataset.address = wallet.address;

  const tabs = document.createElement('div');
  tabs.className = 'asset-tabs';
  tabs.innerHTML = `
    <button class="asset-tab-btn active" data-tab="token">Tokens</button>
    <button class="asset-tab-btn" data-tab="nft">NFTs</button>
  `;

  const { container: tokenGrid, observer: tokenObserver } = createAssetGrid(wallet.assets, 'token');
  const { container: nftGrid, observer: nftObserver } = createAssetGrid(wallet.assets, 'nft');

  tokenGrid.classList.add('active');
  panel.appendChild(tabs);
  panel.appendChild(tokenGrid);
  panel.appendChild(nftGrid);

  // Initial load
  loadAssetsInBatches(wallet).then(assets => {
    appendAssetsToGrid(assets.slice(0, ASSETS_PER_PAGE), tokenGrid, 'token', tokenObserver);
    appendAssetsToGrid(assets.slice(0, ASSETS_PER_PAGE), nftGrid, 'nft', nftObserver);
  });

  return panel;
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
      
      // Update active tab button
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Render assets for the selected tab
      renderAssetsList(currentWallet, tabType);
    });
  });
}

function renderAssetsList(walletIndex, tabType) {
  const wallet = wallets[walletIndex];
  const assetsPanel = document.querySelector('.assets-panel');
  const assetGrid = assetsPanel.querySelector(`.assets-grid.${tabType}`);

  // Clear existing assets
  assetGrid.innerHTML = '';

  // Load assets for the selected tab
  loadAssetsInBatches(wallet).then(assets => {
    const filteredAssets = assets.filter(asset => {
      if (tabType === 'nft') return isNFT(asset);
      return !isNFT(asset);
    });

    // Append assets to grid
    appendAssetsToGrid(filteredAssets, assetGrid, tabType);
  });
}
