// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "walletAdded") {
    // Forward the message to all fullview tabs
    chrome.tabs.query({url: chrome.runtime.getURL("fullview.html")}, function(tabs) {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {action: "walletAdded"});
      });
    });
  }
});

// Initialize slots if not already set
chrome.runtime.onInstalled.addListener(async () => {
  const { availableSlots } = await chrome.storage.sync.get('availableSlots');
  if (typeof availableSlots === 'undefined') {
    await chrome.storage.sync.set({ availableSlots: MAX_FREE_SLOTS });
  }
});

// Listen for storage changes to keep UI in sync
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  // If wallet index changes, notify any open tabs
  if (namespace === 'sync' && (changes.wallet_index || changes.unlockedSlots || changes.availableSlots)) {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_WALLETS' });
    });
  }
  if (namespace === 'sync' && changes.availableSlots) {
    console.log('Slots updated:', changes.availableSlots.newValue);
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_FULLVIEW') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('fullview.html')
    });
  } else if (message.type === 'WALLET_ADDED') {
    // When a wallet is added, notify all fullview tabs
    chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_WALLETS' });
      });
    });
  }
});
