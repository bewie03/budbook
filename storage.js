// Storage keys
const STORAGE_KEYS = {
  WALLETS: 'wallets',
  WALLET_DATA: 'wallet_data_',
  WALLET_ICON: 'wallet_icon_',
  USER_SLOTS: 'user_slots',
  USER_PREFERENCES: 'user_preferences'
};

// Storage management
class StorageManager {
  // User data in sync storage
  static async getUserData() {
    const data = await chrome.storage.sync.get([
      STORAGE_KEYS.USER_SLOTS,
      STORAGE_KEYS.USER_PREFERENCES
    ]);
    return {
      slots: data[STORAGE_KEYS.USER_SLOTS] || { purchased: 0, used: 0 },
      preferences: data[STORAGE_KEYS.USER_PREFERENCES] || {}
    };
  }

  static async updateUserData(userData) {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.USER_SLOTS]: userData.slots,
      [STORAGE_KEYS.USER_PREFERENCES]: userData.preferences
    });
  }

  // Wallet data in local storage
  static async getWallets() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.WALLETS);
    return data[STORAGE_KEYS.WALLETS] || [];
  }

  static async saveWallets(wallets) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.WALLETS]: wallets
    });
  }

  static async getWalletData(address) {
    const key = STORAGE_KEYS.WALLET_DATA + address;
    const data = await chrome.storage.local.get(key);
    return data[key];
  }

  static async saveWalletData(address, data) {
    const key = STORAGE_KEYS.WALLET_DATA + address;
    await chrome.storage.local.set({
      [key]: {
        ...data,
        timestamp: Date.now()
      }
    });
  }

  static async getWalletIcon(address) {
    const key = STORAGE_KEYS.WALLET_ICON + address;
    const data = await chrome.storage.local.get(key);
    return data[key];
  }

  static async saveWalletIcon(address, iconData) {
    const key = STORAGE_KEYS.WALLET_ICON + address;
    await chrome.storage.local.set({
      [key]: iconData
    });
  }

  // Storage usage monitoring
  static async getStorageUsage() {
    const [syncUsage, localUsage] = await Promise.all([
      navigator.storage.estimate(),
      chrome.storage.local.getBytesInUse()
    ]);

    return {
      sync: {
        used: syncUsage.usage || 0,
        quota: syncUsage.quota || 102400 // 100KB default
      },
      local: {
        used: localUsage,
        quota: chrome.storage.local.QUOTA_BYTES
      }
    };
  }

  // Cleanup old data
  static async cleanupOldData(maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
    const now = Date.now();
    const data = await chrome.storage.local.get(null);
    
    const keysToRemove = Object.entries(data)
      .filter(([key, value]) => {
        // Only clean up wallet data, not icons or other settings
        if (!key.startsWith(STORAGE_KEYS.WALLET_DATA)) return false;
        return value.timestamp && (now - value.timestamp > maxAge);
      })
      .map(([key]) => key);

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  }
}

export { StorageManager, STORAGE_KEYS };
