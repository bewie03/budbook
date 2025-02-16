import { StorageManager } from './storage.js';
import { 
    WALLET_LOGOS, 
    MAX_FREE_SLOTS, 
    SLOTS_PER_PAYMENT,
    MAX_TOTAL_SLOTS,
    BONE_PAYMENT_AMOUNT,
    API_BASE_URL,
    MAX_STORED_ASSETS,
    ADA_LOVELACE,
    BONE_POLICY_ID,
    BONE_ASSET_NAME,
    CURRENCIES
} from './constants.js';

// Constants
// Removed constants as they are now imported from constants.js

// Available wallet logos
// Removed WALLET_LOGOS as it is now imported from constants.js

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
        await handlePaymentSuccess();
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
  try {
    const wallets = await StorageManager.getWallets();
    const container = document.getElementById('wallet-list');
    container.innerHTML = '';

    for (const wallet of wallets) {
      const walletData = await StorageManager.getWalletData(wallet.address);
      const icon = await StorageManager.getWalletIcon(wallet.address);
      
      // Create wallet list item
      const listItem = createWalletListItem(wallet, walletData, icon);
      container.appendChild(listItem);
    }
  } catch (error) {
    console.error('Error loading wallet list:', error);
  }
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
  const addWalletBtn = document.getElementById('addWallet');

  const address = addressInput.value.trim();
  const name = nameInput.value.trim();
  const walletType = walletTypeSelect.value;

  // Validation
  if (!address) {
    showMessage('Please enter a wallet address', 'error');
    return;
  }
  if (!name) {
    showMessage('Please enter a wallet name', 'error');
    return;
  }
  if (wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) {
    showMessage('A wallet with this name already exists', 'error');
    return;
  }
  if (wallets.some(w => w.address === address)) {
    showMessage('This wallet has already been added', 'error');
    return;
  }

  // Show loading state
  addWalletBtn.disabled = true;
  showMessage('Adding wallet...', 'info');

  try {
    // Add temporary wallet to the list immediately
    const tempWallet = {
      name,
      address,
      walletType,
      isLoading: true,
      balance: '0',
      assets: []
    };
    
    wallets.push(tempWallet);
    await saveWallets();

    // Notify fullview to show loading state
    const fullviewTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
    if (fullviewTabs.length > 0) {
      chrome.tabs.sendMessage(fullviewTabs[0].id, { 
        action: 'walletLoading',
        wallet: {
          name,
          address,
          walletType: walletType,
          customIcon: walletType === 'Custom' ? customIconData : undefined
        }
      });
    }

    // Fetch wallet data
    const data = await fetchWalletData(address);
    
    // Update the wallet with real data
    const walletIndex = wallets.findIndex(w => w.address === address);
    if (walletIndex !== -1) {
      wallets[walletIndex] = {
        name,
        address,
        walletType,
        isLoading: false,
        ...data
      };
    }

    // Save wallets
    await saveWallets();
    
    // Clear inputs
    addressInput.value = '';
    nameInput.value = '';
    walletTypeSelect.value = 'None';
    
    // Notify all fullview tabs to reload
    const tabs = await chrome.tabs.query({url: chrome.runtime.getURL('fullview.html')});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_WALLETS' });
    });

    // Show success message
    showMessage('Wallet added successfully!', 'success');
    updateUI();

    // Refresh fullview with complete data
    if (fullviewTabs.length > 0) {
      chrome.tabs.sendMessage(fullviewTabs[0].id, { 
        action: 'walletLoaded',
        wallet: wallets[walletIndex]
      });
    }

    // Save custom icon if present
    if (walletType === 'Custom' && customIconData) {
      await chrome.storage.local.set({
        [`wallet_icon_${address}`]: customIconData
      });
      wallets[walletIndex].customIcon = customIconData;
    }
  } catch (error) {
    // Remove temporary wallet if it exists
    const walletIndex = wallets.findIndex(w => w.address === address);
    if (walletIndex !== -1) {
      wallets.splice(walletIndex, 1);
      await saveWallets();
    }
    showMessage(error.message || 'Failed to add wallet', 'error');
  } finally {
    addWalletBtn.disabled = false;
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

async function handlePaymentSuccess() {
  try {
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
const MAX_ICON_SIZE = 32; // pixels
const MAX_FILE_SIZE = 32 * 1024; // 32KB
const JPEG_QUALITY = 0.8;

async function optimizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Create canvas for resizing
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Calculate new dimensions while maintaining aspect ratio
        if (width > height) {
          if (width > MAX_ICON_SIZE) {
            height = Math.round(height * MAX_ICON_SIZE / width);
            width = MAX_ICON_SIZE;
          }
        } else {
          if (height > MAX_ICON_SIZE) {
            width = Math.round(width * MAX_ICON_SIZE / height);
            height = MAX_ICON_SIZE;
          }
        }

        canvas.width = width;
        canvas.height = height;

        // Draw resized image
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to WebP if supported, otherwise JPEG
        let mimeType = 'image/webp';
        let quality = JPEG_QUALITY;

        // Fallback to JPEG if WebP not supported
        if (!canvas.toDataURL('image/webp').startsWith('data:image/webp')) {
          mimeType = 'image/jpeg';
        }

        // Get optimized base64
        const optimizedBase64 = canvas.toDataURL(mimeType, quality);
        
        // Check final size
        const size = Math.round((optimizedBase64.length - 22) * 0.75);
        if (size > MAX_FILE_SIZE) {
          reject(new Error('Image still too large after optimization'));
          return;
        }

        resolve(optimizedBase64);
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function setupCustomIconUpload() {
  const walletType = document.getElementById('walletType');
  const customIconUpload = document.getElementById('customIconUpload');
  const iconFile = document.getElementById('iconFile');
  const uploadButton = document.getElementById('uploadButton');
  const selectedIcon = document.getElementById('selectedIcon');
  const iconPreview = document.getElementById('iconPreview');
  const removeIcon = document.getElementById('removeIcon');

  walletType.addEventListener('change', (e) => {
    customIconUpload.style.display = e.target.value === 'Custom' ? 'block' : 'none';
    if (e.target.value !== 'Custom') {
      customIconData = null;
      selectedIcon.style.display = 'none';
    }
  });

  uploadButton.addEventListener('click', () => {
    iconFile.click();
  });

  iconFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showError('Please select an image file');
      return;
    }

    try {
      // Show loading state
      uploadButton.disabled = true;
      uploadButton.textContent = 'Optimizing...';

      // Optimize image
      customIconData = await optimizeImage(file);
      
      // Update preview
      iconPreview.src = customIconData;
      selectedIcon.style.display = 'flex';

      // Show success message with size info
      const size = Math.round((customIconData.length - 22) * 0.75 / 1024);
      showSuccess(`Image optimized (${size}KB)`);
    } catch (error) {
      console.error('Error processing image:', error);
      showError(error.message || 'Failed to process image');
      customIconData = null;
    } finally {
      // Reset upload button
      uploadButton.disabled = false;
      uploadButton.textContent = 'Choose Icon';
    }
  });

  removeIcon.addEventListener('click', () => {
    customIconData = null;
    iconFile.value = '';
    selectedIcon.style.display = 'none';
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
  } catch (error) {
    console.error('Error initializing popup:', error);
    showError('Failed to initialize. Please try again.');
  }
});

// Helper Functions
function showMessage(message, type = 'info') {
  const container = document.getElementById('messageContainer');
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  messageDiv.textContent = message;

  // Clear existing messages
  container.innerHTML = '';
  container.appendChild(messageDiv);

  // Show message with fade in
  messageDiv.style.animation = 'slideIn 0.5s ease, fadeIn 0.5s ease';

  // Keep message visible for 5 seconds then fade out
  setTimeout(() => {
    messageDiv.style.animation = 'slideOut 0.5s ease, fadeOut 0.5s ease';
    setTimeout(() => {
      if (container.contains(messageDiv)) {
        container.removeChild(messageDiv);
      }
    }, 500);
  }, 5000);
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
    return data[`wallet_icon_${address}`] || WALLET_LOGOS['None'];
  }
  return WALLET_LOGOS[walletType] || WALLET_LOGOS['None'];
}
