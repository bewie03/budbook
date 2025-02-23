// Google Auth handling
class Auth {
    constructor() {
        this.userInfo = null;
        this.init();
    }

    async init() {
        // Try to get cached user info
        const cached = await chrome.storage.sync.get(['userInfo']);
        if (cached.userInfo) {
            this.userInfo = cached.userInfo;
        }
    }

    async getUserId() {
        if (this.userInfo) {
            return this.userInfo.id;
        }
        
        try {
            const token = await this.getAuthToken();
            const userInfo = await this.fetchUserInfo(token);
            
            // Cache user info
            this.userInfo = userInfo;
            await chrome.storage.sync.set({ userInfo });
            
            return userInfo.id;
        } catch (error) {
            console.error('Error getting user ID:', error);
            throw error;
        }
    }

    async getAuthToken() {
        try {
            const token = await chrome.identity.getAuthToken({ interactive: true });
            return token;
        } catch (error) {
            console.error('Error getting auth token:', error);
            throw error;
        }
    }

    async fetchUserInfo(token) {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                throw new Error('Failed to fetch user info');
            }
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching user info:', error);
            throw error;
        }
    }

    async signOut() {
        try {
            await chrome.identity.removeCachedAuthToken();
            this.userInfo = null;
            await chrome.storage.sync.remove(['userInfo']);
        } catch (error) {
            console.error('Error signing out:', error);
            throw error;
        }
    }
}

// Export singleton
export const auth = new Auth();
