// Constants
const MAX_FREE_SLOTS = 5;
const SLOTS_PER_PAYMENT = 10;
const MAX_TOTAL_SLOTS = 100;
const ADA_PAYMENT_AMOUNT = 10;

// API configuration
const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';

class CardanoAddressBook {
  constructor() {
    this.init();
    this.setupEventListeners();
  }

  async init() {
    this.container = document.getElementById('root');
    this.render();
    await this.loadWallets();
  }

  async loadWallets() {
    const { wallets = [], unlockedSlots = MAX_FREE_SLOTS } = await chrome.storage.sync.get(['wallets', 'unlockedSlots']);
    this.wallets = wallets;
    this.unlockedSlots = unlockedSlots;
    this.updateUI();
  }

  setupEventListeners() {
    document.addEventListener('click', async (e) => {
      if (e.target.matches('#addWallet')) {
        await this.addWallet();
      } else if (e.target.matches('#unlockSlots')) {
        await this.initiateSlotPurchase();
      }
    });
  }

  async addWallet() {
    const addressInput = document.querySelector('#walletAddress');
    const nameInput = document.querySelector('#walletName');
    const address = addressInput.value.trim();
    const name = nameInput.value.trim();

    if (!this.validateAddress(address)) {
      this.showError('Invalid Cardano address');
      return;
    }

    if (this.wallets.length >= this.unlockedSlots) {
      this.showError('Maximum wallet slots reached. Please unlock more slots.');
      return;
    }

    try {
      const walletData = await this.fetchWalletData(address);
      this.wallets.push({
        address,
        name,
        balance: walletData.balance,
        stake_address: walletData.stake_address,
        timestamp: Date.now()
      });

      await chrome.storage.sync.set({ wallets: this.wallets });
      this.updateUI();
      addressInput.value = '';
      nameInput.value = '';
    } catch (error) {
      this.showError('Error fetching wallet data');
    }
  }

  async fetchWalletData(address) {
    const response = await fetch(`${API_BASE_URL}/api/wallet/${address}`);
    
    if (!response.ok) {
      throw new Error('Failed to fetch wallet data');
    }

    return await response.json();
  }

  validateAddress(address) {
    // Basic validation - should be replaced with proper Cardano address validation
    return address.startsWith('addr1') && address.length >= 59;
  }

  async initiateSlotPurchase() {
    if (this.unlockedSlots >= MAX_TOTAL_SLOTS) {
      this.showError('Maximum total slots reached');
      return;
    }

    // Generate payment address (this should be your project's payment address)
    const paymentAddress = 'addr1...'; // Replace with actual payment address
    
    // Show payment instructions
    this.showPaymentInstructions(paymentAddress);
    
    // Start checking for payment
    this.checkForPayment(paymentAddress);
  }

  async checkForPayment(paymentAddress) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/verify-payment/${paymentAddress}`);
      const data = await response.json();
      
      if (data.verified) {
        this.unlockedSlots += SLOTS_PER_PAYMENT;
        await chrome.storage.sync.set({ unlockedSlots: this.unlockedSlots });
        this.updateUI();
        this.showSuccess('Payment verified! New slots unlocked.');
      }
    } catch (error) {
      console.error('Error verifying payment:', error);
    }
  }

  showPaymentInstructions(paymentAddress) {
    const instructions = document.createElement('div');
    instructions.innerHTML = `
      <div class="payment-instructions">
        <h3>Unlock More Slots</h3>
        <p>Send ${ADA_PAYMENT_AMOUNT} ADA to:</p>
        <code>${paymentAddress}</code>
        <p>You will receive ${SLOTS_PER_PAYMENT} additional wallet slots after payment confirmation.</p>
      </div>
    `;
    this.container.appendChild(instructions);
  }

  showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = message;
    this.container.appendChild(errorDiv);
    setTimeout(() => errorDiv.remove(), 3000);
  }

  showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.className = 'success';
    successDiv.textContent = message;
    this.container.appendChild(successDiv);
    setTimeout(() => successDiv.remove(), 3000);
  }

  updateUI() {
    this.container.innerHTML = `
      <div class="container">
        <div class="header">
          <h1>Cardano Address Book</h1>
          <p>Available Slots: ${this.unlockedSlots - this.wallets.length} / ${this.unlockedSlots}</p>
        </div>
        
        <div class="input-group">
          <input type="text" id="walletAddress" placeholder="Enter Cardano Address" />
          <input type="text" id="walletName" placeholder="Enter Wallet Name" />
          <button id="addWallet">Add Wallet</button>
        </div>

        ${this.unlockedSlots < MAX_TOTAL_SLOTS ? `
          <button id="unlockSlots">Unlock More Slots (${ADA_PAYMENT_AMOUNT} ADA for ${SLOTS_PER_PAYMENT} slots)</button>
        ` : ''}

        <div class="wallet-list">
          ${this.renderWallets()}
        </div>
      </div>
    `;
  }

  renderWallets() {
    if (this.wallets.length === 0) {
      return '<p class="status">No wallets added yet</p>';
    }

    return this.wallets.map(wallet => `
      <div class="wallet-item">
        <h3>${wallet.name}</h3>
        <p>Address: ${wallet.address.substring(0, 20)}...</p>
        <p>Balance: ${wallet.balance / 1000000} ADA</p>
        ${wallet.stake_address ? `<p>Stake Address: ${wallet.stake_address.substring(0, 20)}...</p>` : ''}
      </div>
    `).join('');
  }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  new CardanoAddressBook();
});
