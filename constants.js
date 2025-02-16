// Storage constants
export const STORAGE_KEYS = {
    WALLETS: 'wallets',
    WALLET_DATA: 'wallet_data_',
    WALLET_ICON: 'wallet_icon_',
    USER_SLOTS: 'user_slots',
    USER_PREFERENCES: 'user_preferences'
};

// Slot configuration
export const MAX_FREE_SLOTS = 5;
export const SLOTS_PER_PAYMENT = 5;

// Cache configuration
export const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Wallet logos
export const WALLET_LOGOS = {
    'None': 'assets/wallet-icon.png',
    'Nami': 'assets/nami.png',
    'Eternl': 'assets/eternl.png',
    'Flint': 'assets/flint.png',
    'Gero': 'assets/gero.png',
    'Typhon': 'assets/typhon.png',
    'Yoroi': 'assets/yoroi.png',
    'Custom': ''
};

// API endpoints
export const API_ENDPOINTS = {
    WALLET: '/api/wallet',
    ASSETS: '/api/assets',
    STAKING: '/api/staking'
};
