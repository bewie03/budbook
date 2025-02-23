// Constants
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 5;
const MAX_TOTAL_SLOTS = 100;
const BONE_PAYMENT_AMOUNT = 100;
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';
const MAX_STORED_ASSETS = 5; // Store only top 5 assets by value
const ADA_LOVELACE = 1000000; // 1 ADA = 1,000,000 Lovelace
const BONE_POLICY_ID = ''; // Add your BONE token policy ID here
const BONE_ASSET_NAME = ''; // Add your BONE token asset name here
const CACHE_DURATION = 300000; // 5 minutes

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

// Global state
let wallets = [];
let unlockedSlots = 0;
let currentPaymentId = null;
let eventSource = null;
let customIconData = null;

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

    // Fetch staking info if we have a stake address
    if (data.stake_address) {
      try {
        const stakingResponse = await fetch(`${API_BASE_URL}/api/accounts/${data.stake_address}`);
        if (stakingResponse.ok) {
          data.stakingInfo = await stakingResponse.json();
        }
      } catch (error) {
        console.error('Error fetching staking info:', error);
      }
    }

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
    const response = await fetch(`${API_BASE_URL}/api/initiate-payment`, {
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
    
    // Setup SSE for payment status updates
    if (eventSource) {
      eventSource.close();
    }
    
    eventSource = new EventSource(`${API_BASE_URL}/api/payment-status/${data.paymentId}`);
    
    eventSource.onmessage = async (event) => {
      const paymentStatus = JSON.parse(event.data);
      if (paymentStatus.verified) {
        eventSource.close();
        await handlePaymentSuccess(paymentStatus);
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('SSE Error:', error);
      eventSource.close();
    };
    
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
      // Load wallet index and slots data
      chrome.storage.sync.get(['wallet_index', 'unlockedSlots', 'slots_version', 'wallet_order'], async (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        const walletIndex = result.wallet_index || [];
        const savedOrder = result.wallet_order || [];
        
        // Reset slots if version is old or not set
        if (!result.slots_version || result.slots_version < 1) {
          console.log('Resetting slots to new default of 5');
          await chrome.storage.sync.set({ 
            unlockedSlots: MAX_FREE_SLOTS,
            slots_version: 1
          });
          unlockedSlots = MAX_FREE_SLOTS;
        } else {
          unlockedSlots = result.unlockedSlots || MAX_FREE_SLOTS;
        }

        if (walletIndex.length === 0) {
          wallets = [];
          resolve(wallets);
          return;
        }

        try {
          // Load basic wallet data from sync storage
          const syncData = await Promise.all(
            walletIndex.map(address =>
              new Promise((resolve) => {
                chrome.storage.sync.get(`wallet_${address}`, (result) => {
                  resolve({
                    address,
                    ...(result[`wallet_${address}`] || {})
                  });
                });
              })
            )
          );

          // Load icons from local storage
          const iconData = await Promise.all(
            walletIndex.map(address =>
              new Promise((resolve) => {
                chrome.storage.local.get(`wallet_icon_${address}`, (result) => {
                  const iconData = result[`wallet_icon_${address}`] || {};
                  resolve({
                    customIcon: iconData.customIcon || null
                  });
                });
              })
            )
          );

          // Combine sync and local data
          wallets = syncData.map((wallet, index) => ({
            ...wallet,
            customIcon: iconData[index].customIcon
          }));

          // Order wallets based on saved order
          const orderedWallets = [];
          
          // First add wallets in saved order
          for (const address of savedOrder) {
            const wallet = wallets.find(w => w.address === address);
            if (wallet) {
              orderedWallets.push(wallet);
            }
          }
          
          // Then add any remaining wallets
          wallets.forEach(wallet => {
            if (!orderedWallets.some(w => w.address === wallet.address)) {
              orderedWallets.push(wallet);
            }
          });

          wallets = orderedWallets;
          resolve(wallets);
        } catch (error) {
          reject(error);
        }
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

      // Store wallet data and icons separately
      const syncPromises = wallets.map(wallet => 
        new Promise((resolve, reject) => {
          const syncData = {
            name: wallet.name,
            walletType: wallet.walletType,
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

      // Store icons in local storage
      const localPromises = wallets.map(wallet => 
        new Promise((resolve, reject) => {
          if (wallet.walletType === 'Custom' && wallet.customIcon) {
            chrome.storage.local.set({ 
              [`wallet_icon_${wallet.address}`]: { customIcon: wallet.customIcon }
            }, () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
              }
              resolve();
            });
          } else {
            resolve();
          }
        })
      );

      // Wait for all storage operations to complete
      Promise.all([...syncPromises, ...localPromises])
        .then(() => {
          // Store wallet index and order in sync storage
          chrome.storage.sync.set({ 
            wallet_index: walletIndex,
            wallet_order: walletIndex,
            unlockedSlots: MAX_FREE_SLOTS
          }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
              return;
            }
            resolve();
          });
        })
        .catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

// UI Functions
function showError(message) {
  const container = document.getElementById('messageContainer');
  if (!container) return;

  // Remove any existing messages
  while (container.firstChild) {
    container.firstChild.remove();
  }

  const errorDiv = document.createElement('div');
  errorDiv.className = 'message error';
  errorDiv.textContent = message;
  container.appendChild(errorDiv);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (errorDiv.parentNode === container) {
      errorDiv.remove();
    }
  }, 3000);
}

function showMessage(message, type = 'info') {
  const container = document.getElementById('messageContainer');
  if (!container) return;

  // Remove any existing messages
  while (container.firstChild) {
    container.firstChild.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  messageDiv.textContent = message;
  container.appendChild(messageDiv);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (messageDiv.parentNode === container) {
      messageDiv.remove();
    }
  }, 3000);
}

function validateAddress(address) {
  // Basic validation - let the API handle detailed validation
  if (!address || typeof address !== 'string') return false;
  
  // Just check if it starts with a valid prefix
  const validPrefixes = ['addr1', 'Ae2', 'DdzFF', 'stake1'];
  const hasValidPrefix = validPrefixes.some(prefix => address.startsWith(prefix));
  
  // Minimum length check (reasonable minimum for any Cardano address)
  const hasValidLength = address.length >= 50;
  
  console.log('Address validation:', {
    address,
    hasValidPrefix,
    hasValidLength,
    length: address.length
  });

  return hasValidPrefix && hasValidLength;
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
  // Convert from lovelace to ADA (1 ADA = 1,000,000 lovelace)
  const adaValue = parseFloat(balance) / 1000000;
  return adaValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' ₳';
}

function renderWallets() {
  if (!wallets.length) {
    return '<p class="no-wallets">No wallets added yet</p>';
  }

  return wallets.map((wallet, index) => {
    const icon = wallet.walletType === 'Custom' ? 
      wallet.customIcon : 
      WALLET_LOGOS[wallet.walletType] || WALLET_LOGOS['None'];

    return `
    <div class="wallet-item">
      <div class="wallet-header">
        ${icon ? `<img src="${icon}" class="wallet-icon" alt="${wallet.name} icon">` : ''}
        <h3>${wallet.name}</h3>
      </div>
      <p class="address">Address: ${wallet.address}</p>
      <p class="balance">Balance: ${wallet.balance || 0} ₳</p>
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
  `}).join('');
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
    const usedSlots = wallets.length;
    slotsDisplay.textContent = `${usedSlots} / ${MAX_FREE_SLOTS}`;
  }

  const addWalletBtn = document.getElementById('addWallet');
  if (addWalletBtn) {
    addWalletBtn.disabled = wallets.length >= MAX_FREE_SLOTS;
  }

  const walletTypeSelect = document.getElementById('walletTypeSelector');
  if (walletTypeSelect) {
    walletTypeSelect.innerHTML = renderWalletSelector();
  }

  // Render wallet list
  const walletList = document.getElementById('walletList');
  if (walletList) {
    walletList.innerHTML = renderWallets();
  }
}

function updateSlotDisplay() {
  const slotDisplay = document.getElementById('slotDisplay');
  if (slotDisplay) {
    const usedSlots = wallets.length;
    slotDisplay.textContent = `${usedSlots}/${MAX_FREE_SLOTS}`;
    
    // Update slot warning visibility
    const slotWarning = document.getElementById('slotWarning');
    if (slotWarning) {
      slotWarning.style.display = usedSlots >= MAX_FREE_SLOTS ? 'block' : 'none';
    }
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

async function handlePaymentSuccess(data) {
  try {
    // Update unlocked slots from server response
    if (data && typeof data.slots === 'number') {
      unlockedSlots = data.slots;
    } else {
      // Fallback to adding SLOTS_PER_PAYMENT
      unlockedSlots += SLOTS_PER_PAYMENT;
    }
    
    // Save to storage
    await chrome.storage.sync.set({ unlockedSlots });
    
    // Update UI
    updateUI();
    
    showSuccess(`Payment verified! You now have ${unlockedSlots} wallet slots available.`);
    
    // Close payment instructions if open
    const instructions = document.querySelector('.modal');
    if (instructions) {
      instructions.remove();
    }

    // Reset payment ID and close SSE connection
    currentPaymentId = null;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  } catch (error) {
    console.error('Error handling payment success:', error);
    showError('Error updating slots. Please contact support.');
  }
}

function setupEventListeners() {
  // Populate wallet type selector
  const walletTypeSelect = document.getElementById('walletTypeSelector');
  if (walletTypeSelect) {
    // Clear existing options
    walletTypeSelect.innerHTML = '';
    
    // Add wallet types from WALLET_LOGOS
    Object.keys(WALLET_LOGOS).forEach(type => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      walletTypeSelect.appendChild(option);
    });
  }

  // Add wallet button
  const addWalletBtn = document.getElementById('addWallet');
  if (addWalletBtn) {
    addWalletBtn.addEventListener('click', addWallet);
  }

  // Open fullview button
  const openFullviewBtn = document.getElementById('openFullView');
  if (openFullviewBtn) {
    openFullviewBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('fullview.html') });
    });
  }

  // Input validation and real-time feedback
  const addressInput = document.getElementById('addressInput');
  addressInput.addEventListener('input', () => {
    const address = addressInput.value.trim();
    if (address && wallets.some(w => w.address === address)) {
      showError('This wallet has already been added', 'error');
    }
  });

  const nameInput = document.getElementById('nameInput');
  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim();
    if (name && wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) {
      showError('A wallet with this name already exists', 'error');
    }
  });

  setupCustomIconUpload();
}

// Image optimization settings
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_STORAGE_SIZE = 5 * 1024 * 1024; // 5MB (Chrome's per-item limit)
const INITIAL_QUALITY = 0.9;
const MIN_QUALITY = 0.5;
const QUALITY_STEP = 0.1;

async function optimizeImage(file) {
  return new Promise((resolve, reject) => {
    // Pre-check file size
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error(`Image file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Please choose an image under 1MB`));
      return;
    }

    // For GIFs, just read as base64 without optimization
    if (file.type === 'image/gif') {
      const reader = new FileReader();
      reader.onload = (e) => {
        resolve(e.target.result);
      };
      reader.onerror = () => reject(new Error('Failed to read GIF file'));
      reader.readAsDataURL(file);
      return;
    }

    // For other image types, optimize as before
    const img = new Image();
    const reader = new FileReader();

    reader.onload = function(e) {
      img.src = e.target.result;
    };

    img.onload = function() {
      const canvas = document.createElement('canvas');
      let { width, height } = img;

      // Keep original dimensions but ensure reasonable size
      const maxDimension = Math.max(width, height);
      if (maxDimension > 512) { // Only scale down if larger than 512px
        const scale = 512 / maxDimension;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Try different quality settings until size is under limit
      let quality = INITIAL_QUALITY;
      let result;

      do {
        result = canvas.toDataURL('image/webp', quality);
        quality -= QUALITY_STEP;
      } while (quality >= MIN_QUALITY && result.length > MAX_FILE_SIZE);

      if (result.length > MAX_FILE_SIZE) {
        reject(new Error('Could not optimize image to under 1MB. Please try a smaller image.'));
        return;
      }

      resolve(result);
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    reader.readAsDataURL(file);
  });
}

function setupCustomIconUpload() {
  const iconFile = document.getElementById('iconFile');
  const uploadButton = document.getElementById('uploadButton');
  const selectedIcon = document.getElementById('selectedIcon');
  const iconPreview = document.getElementById('iconPreview');
  const walletType = document.getElementById('walletType');

  // Remove any existing listeners
  uploadButton.replaceWith(uploadButton.cloneNode(true));
  iconFile.replaceWith(iconFile.cloneNode(true));
  
  // Get fresh references after replacing
  const newUploadButton = document.getElementById('uploadButton');
  const newIconFile = document.getElementById('iconFile');

  walletType.addEventListener('change', function() {
    const isCustom = this.value === 'Custom';
    document.getElementById('customIconUpload').style.display = isCustom ? 'block' : 'none';
    if (!isCustom) {
      customIconData = null;
      selectedIcon.style.display = 'none';
    }
  });

  newUploadButton.addEventListener('click', () => {
    newIconFile.click();
  });

  newIconFile.addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;

    try {
      // Show loading state
      newUploadButton.disabled = true;
      showMessage('Processing image...', 'info');

      // Pre-check file size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`Image file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Please choose an image under 1MB`);
      }

      // Pre-check image dimensions
      try {
        const dimensions = await getImageDimensions(file);
        if (dimensions.width > 512 || dimensions.height > 512) {
          showError('Image dimensions must be 512x512 pixels or smaller');
          return;
        }
      } catch (error) {
        showError('Failed to check image dimensions');
        return;
      }

      // Pre-check storage quota
      try {
        const { quota, usage } = await navigator.storage.estimate();
        if (usage + file.size > quota) {
          showError('Not enough storage space. Try removing some wallets first.');
          return;
        }
      } catch (error) {
        console.error('Failed to check storage quota:', error);
      }

      // Optimize and store the image
      customIconData = await optimizeImage(file);
      
      // Show preview
      iconPreview.src = customIconData;
      selectedIcon.style.display = 'block';
      
      showMessage('Icon selected successfully!', 'success');
    } catch (error) {
      showError(error.message || 'Failed to process image');
      customIconData = null;
      selectedIcon.style.display = 'none';
    } finally {
      newUploadButton.disabled = false;
      this.value = ''; // Reset file input
    }
  });
}

// Cleanup function
function cleanup() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// Add cleanup on window unload
window.addEventListener('unload', cleanup);

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadWallets();
    updateUI();  
    setupEventListeners();
    setupCustomIconUpload();
  } catch (error) {
    console.error('Error initializing popup:', error);
    showError('Failed to initialize. Please try again.');
  }
});

// Helper Functions
function showMessage(message, type = 'info') {
  const container = document.getElementById('messageContainer');
  if (!container) return;

  // Remove any existing messages
  while (container.firstChild) {
    container.firstChild.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  messageDiv.textContent = message;
  container.appendChild(messageDiv);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (messageDiv.parentNode === container) {
      messageDiv.remove();
    }
  }, 3000);
}

function setLoading(element, isLoading) {
  if (isLoading) {
    element.classList.add('loading');
    element.disabled = true;
  } else {
    element.classList.remove('loading');
    element.disabled = false;
  }
}

async function getWalletLogo(walletType, address) {
  if (walletType === 'Custom') {
    const data = await chrome.storage.local.get(`wallet_icon_${address}`);
    const iconData = data[`wallet_icon_${address}`];
    return iconData?.customIcon || WALLET_LOGOS['None'];
  }
  return WALLET_LOGOS[walletType] || WALLET_LOGOS['None'];
}

async function addWallet() {
  const addressInput = document.getElementById('addressInput');
  const nameInput = document.getElementById('nameInput');
  const walletTypeSelect = document.getElementById('walletType');
  const addButton = document.getElementById('addWallet');

  try {
    const address = addressInput.value.trim();
    const name = nameInput.value.trim();
    const walletType = walletTypeSelect.value;

    // Validate inputs
    if (!address) {
      showError('Please enter a wallet address');
      return;
    }

    if (!name) {
      showError('Please enter a wallet name');
      return;
    }

    if (name.length > 25) {
      showError('Wallet name must be 25 characters or less');
      return;
    }

    if (!validateAddress(address)) {
      showError('Please enter a valid Cardano address');
      return;
    }

    // Check for duplicate wallet name
    if (wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) {
      showError('A wallet with this name already exists');
      return;
    }

    // Check for duplicate wallet address
    if (wallets.some(w => w.address === address)) {
      showError('This wallet has already been added');
      return;
    }

    if (wallets.length >= MAX_FREE_SLOTS) {
      showError('No available slots. Please unlock more slots.');
      return;
    }

    addButton.disabled = true;
    showMessage('Adding wallet...', 'info');

    // Create the wallet object
    const newWallet = {
      name,
      address,
      walletType,
      customIcon: walletType === 'Custom' ? customIconData : null
    };

    // First notify fullview that we're adding a wallet
    const fullviewTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
    
    // Send WALLET_ADDED message before saving to storage
    if (fullviewTabs.length > 0) {
      chrome.tabs.sendMessage(fullviewTabs[0].id, {
        type: 'WALLET_ADDED',
        wallet: newWallet
      });
    }

    // Add wallet locally and save
    wallets.push(newWallet);
    await saveWallets();

    // Show success and update UI
    showMessage('Wallet added successfully!', 'success');
    updateSlotDisplay();

    // Clear form
    addressInput.value = '';
    nameInput.value = '';
    walletTypeSelect.value = 'None';
    customIconData = null;

    const selectedIcon = document.getElementById('selectedIcon');
    if (selectedIcon) {
      selectedIcon.style.display = 'none';
    }

    const customIconUpload = document.getElementById('customIconUpload');
    if (customIconUpload) {
      customIconUpload.style.display = 'none';
    }

  } catch (error) {
    console.error('Error adding wallet:', error);
    showError('Failed to add wallet. Please try again.');
  } finally {
    addButton.disabled = false;
  }
}

function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.width,
          height: img.height
        });
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
