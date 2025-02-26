// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "walletAdded") {
    // Forward the message to all fullview tabs
    chrome.tabs.query({url: chrome.runtime.getURL("fullview.html")}, function(tabs) {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {action: "walletAdded"});
      });
    });
  } else if (message.type === 'SLOTS_UPDATED') {
    // Forward slot updates to popup
    chrome.runtime.sendMessage({ type: 'UPDATE_POPUP_SLOTS', slots: message.slots });
    
    // Forward to all fullview tabs except sender
    chrome.tabs.query({url: chrome.runtime.getURL("fullview.html")}, function(tabs) {
      tabs.forEach(tab => {
        if (tab.id !== sender.tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SLOTS', slots: message.slots });
        }
      });
    });
  } else if (message.type === 'OPEN_FULLVIEW') {
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

// Listen for storage changes to keep UI in sync
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'sync' && (changes.wallet_index || changes.unlockedSlots || changes[`slots:${chrome.runtime.id}`])) {
    if (changes.wallet_index || changes.unlockedSlots) {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_WALLETS' });
      });
    }
    if (changes[`slots:${chrome.runtime.id}`]) {
      const newSlots = changes[`slots:${chrome.runtime.id}`].newValue;
      
      // Update popup
      chrome.runtime.sendMessage({ type: 'UPDATE_POPUP_SLOTS', slots: newSlots });
      
      // Update all fullview tabs
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('fullview.html') });
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SLOTS', slots: newSlots });
      });
    }
  }
});

// Initialize slot manager when extension starts
const slotManager = new SlotManager();
slotManager.startSync(chrome.runtime.id);
