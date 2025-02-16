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
export const MAX_TOTAL_SLOTS = 100;

// Cache configuration
export const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// API Configuration
export const API_BASE_URL = 'https://budbook-2410440cbb61.herokuapp.com';
export const MAX_STORED_ASSETS = 5; // Store only top 5 assets by value
export const ADA_LOVELACE = 1000000; // 1 ADA = 1,000,000 Lovelace

// Payment Configuration
export const BONE_PAYMENT_AMOUNT = 100;
export const BONE_POLICY_ID = ''; // Add your BONE token policy ID here
export const BONE_ASSET_NAME = ''; // Add your BONE token asset name here

// Currency Configuration
export const CURRENCIES = {
    'ADA': { symbol: '₳', rate: 1 },
    'USD': { symbol: '$', rate: 0 },
    'EUR': { symbol: '€', rate: 0 },
    'GBP': { symbol: '£', rate: 0 }
};

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
