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
