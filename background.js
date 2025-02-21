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
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Set initial free slots
    chrome.storage.sync.set({ availableSlots: 5 });
  }
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

// Listen for messages from the server
chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
  try {
    if (message.type === 'payment_verified') {
      console.log('Received payment verification:', message);
      
      // Store verification in local storage
      await chrome.storage.local.set({
        [`payment_${message.paymentId}`]: {
          verified: true,
          message: message.message,
          txHash: message.txHash,
          timestamp: Date.now()
        }
      });

      // Forward the message to all tabs
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, message).catch(err => {
          console.error('Error sending message to tab:', err);
        });
      });
    }
  } catch (error) {
    console.error('Error handling external message:', error);
  }
});

// Listen for webhook notifications from our server
chrome.runtime.onMessageExternal.addListener(
  async function(request, sender, sendResponse) {
    console.log('Received external message:', request, 'from:', sender.url);
    
    if (sender.url.startsWith('https://budbook-2410440cbb61.herokuapp.com')) {
      if (request.type === 'payment_verified') {
        const { paymentId, txHash, message } = request;
        
        console.log('Payment verified:', paymentId, txHash);
        
        try {
          // Store the verification
          await chrome.storage.local.set({
            [`payment_${paymentId}`]: {
              verified: true,
              message,
              txHash,
              timestamp: Date.now()
            }
          });

          // Notify all extension views
          chrome.runtime.sendMessage({
            type: 'payment_verified',
            paymentId,
            txHash,
            message
          });
          
          // Send response back to server
          sendResponse({ success: true });
        } catch (error) {
          console.error('Error handling payment verification:', error);
          sendResponse({ success: false, error: error.message });
        }
        
        // Return true to indicate we'll send response asynchronously
        return true;
      }
    }
  }
);
