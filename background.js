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

// Listen for storage changes to keep UI in sync
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  // If wallet index changes, notify any open tabs
  if (namespace === 'sync' && (changes.wallet_index || changes.unlockedSlots)) {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_WALLETS' });
    });
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_FULLVIEW') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('fullview.html')
    });
  }
});
