// Google Auth handling
class Auth {
    constructor() {
        this.userInfo = null;
    }

    async init() {
        try {
            // Try to get cached user info
            const cached = await chrome.storage.sync.get(['userInfo']);
            if (cached.userInfo) {
                this.userInfo = cached.userInfo;
            }
        } catch (error) {
            console.error('Error initializing auth:', error);
            // Don't throw, just log the error
        }
    }

    async getUserId() {
        if (this.userInfo) {
            return this.userInfo.id;
        }
        
        try {
            const token = await this.getAuthToken();
            if (!token) {
                console.log('No auth token available');
                return null;
            }

            const userInfo = await this.fetchUserInfo(token);
            if (!userInfo) {
                console.log('No user info available');
                return null;
            }
            
            // Cache user info
            this.userInfo = userInfo;
            await chrome.storage.sync.set({ userInfo });
            
            return userInfo.id;
        } catch (error) {
            console.error('Error getting user ID:', error);
            return null;
        }
    }

    async getAuthToken() {
        try {
            // Check if chrome.identity is available
            if (!chrome.identity) {
                console.error('chrome.identity not available');
                return null;
            }

            return await new Promise((resolve, reject) => {
                chrome.identity.getAuthToken({ interactive: true }, (token) => {
                    if (chrome.runtime.lastError) {
                        console.error('Auth token error:', chrome.runtime.lastError);
                        resolve(null);
                        return;
                    }
                    resolve(token);
                });
            });
        } catch (error) {
            console.error('Error getting auth token:', error);
            return null;
        }
    }

    async fetchUserInfo(token) {
        try {
            if (!token) {
                console.log('No token provided to fetchUserInfo');
                return null;
            }

            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                console.error('Failed to fetch user info:', response.status);
                return null;
            }
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching user info:', error);
            return null;
        }
    }

    async signOut() {
        try {
            if (chrome.identity) {
                await new Promise((resolve) => {
                    chrome.identity.clearAllCachedAuthTokens(resolve);
                });
            }
            this.userInfo = null;
            await chrome.storage.sync.remove(['userInfo']);
        } catch (error) {
            console.error('Error signing out:', error);
            // Don't throw, just log the error
        }
    }

    async getUserInfo() {
        if (this.userInfo) {
            return this.userInfo;
        }
        
        try {
            const token = await this.getAuthToken();
            if (!token) {
                console.log('No auth token available');
                return null;
            }

            const userInfo = await this.fetchUserInfo(token);
            if (!userInfo) {
                console.log('No user info available');
                return null;
            }
            
            // Cache user info
            this.userInfo = userInfo;
            await chrome.storage.sync.set({ userInfo });
            
            return userInfo;
        } catch (error) {
            console.error('Error getting user info:', error);
            return null;
        }
    }
}

// Create singleton instance
const auth = new Auth();

// Initialize auth when service worker starts
auth.init().catch(console.error);

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_USER_INFO') {
    auth.getUserInfo()
      .then(userInfo => sendResponse(userInfo))
      .catch(error => {
        console.error('Error getting user info:', error);
        sendResponse(null);
      });
    return true; // Will respond asynchronously
  }
});

// Export for modules
export { auth };
