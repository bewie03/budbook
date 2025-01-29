# Cardano Address Book Chrome Extension

A Chrome extension that allows users to store, name, and track Cardano wallet addresses. View staking information, balance, and transaction history for your favorite Cardano wallets.

## Features

- Add and name Cardano wallet addresses
- View wallet details including:
  - ADA balance
  - Staking pool information
  - Transaction history
- Free tier: Track up to 5 wallets
- Premium features: Unlock additional wallet slots (10 slots for 10 ADA)
- Maximum capacity: 100 wallet slots

## Setup Instructions

1. Clone this repository
2. Get a Blockfrost API key from [blockfrost.io](https://blockfrost.io)
3. Create a `config.js` file with your API key:
   ```javascript
   export const CONFIG = {
       BLOCKFROST_API_KEY: 'your-api-key-here'
   };
   ```
   ⚠️ IMPORTANT: Never commit your `config.js` file to version control! It contains sensitive API keys.
4. Load the extension in Chrome:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked" and select this directory

## Usage

1. Click the extension icon in Chrome
2. Enter a Cardano wallet address and custom name
3. Click "Add Wallet" to save
4. View wallet details in the popup window
5. To unlock more slots:
   - Click "Unlock More Slots"
   - Send 10 ADA to the displayed address
   - Wait for transaction confirmation

## Development

The extension is built using vanilla JavaScript and Chrome Extension APIs. Key files:

- `manifest.json`: Extension configuration
- `popup.html`: Main extension interface
- `popup.js`: Core functionality
- `styles.css`: Extension styling

## Security

- All data is stored locally using Chrome's Storage API
- No external servers are used (except Blockfrost API)
- Payments are verified on-chain through Blockfrost API

## License

MIT License
