const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Create a connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Heroku
    }
});

// Test the connection
pool.connect()
    .then(client => {
        console.log('Successfully connected to PostgreSQL');
        client.release();
    })
    .catch(err => {
        console.error('Error connecting to PostgreSQL:', err);
    });

// Helper functions for database operations
const db = {
    // User operations
    async createUser(googleId, email) {
        const query = `
            INSERT INTO users (google_id, email)
            VALUES ($1, $2)
            RETURNING id`;
        const { rows } = await pool.query(query, [googleId, email]);
        return rows[0];
    },

    async getUserByGoogleId(googleId) {
        const query = 'SELECT * FROM users WHERE google_id = $1';
        const { rows } = await pool.query(query, [googleId]);
        return rows[0];
    },

    async updatePaymentStatus(userId, status) {
        const query = `
            UPDATE users 
            SET payment_status = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *`;
        const { rows } = await pool.query(query, [userId, status]);
        return rows[0];
    },

    // Wallet operations
    async addWallet(userId, address, label = null) {
        const query = `
            INSERT INTO wallets (user_id, address, label)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, address) 
            DO UPDATE SET label = EXCLUDED.label
            RETURNING *`;
        const { rows } = await pool.query(query, [userId, address, label]);
        return rows[0];
    },

    async getUserWallets(userId) {
        const query = `
            SELECT w.*, 
                   json_agg(DISTINCT a.*) as assets,
                   json_agg(DISTINCT t.*) as recent_transactions
            FROM wallets w
            LEFT JOIN assets a ON w.id = a.wallet_id
            LEFT JOIN transactions t ON w.id = t.wallet_id
            WHERE w.user_id = $1
            GROUP BY w.id`;
        const { rows } = await pool.query(query, [userId]);
        return rows;
    },

    // Asset operations
    async updateWalletAssets(walletId, assets) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Clear existing assets for this wallet
            await client.query('DELETE FROM assets WHERE wallet_id = $1', [walletId]);
            
            // Insert new assets
            for (const asset of assets) {
                const query = `
                    INSERT INTO assets (wallet_id, policy_id, asset_name, quantity, metadata)
                    VALUES ($1, $2, $3, $4, $5)`;
                await client.query(query, [
                    walletId,
                    asset.policy_id,
                    asset.asset_name,
                    asset.quantity,
                    asset.metadata
                ]);
            }
            
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    },

    // Payment operations
    async createPayment(userId, txHash, amount) {
        const query = `
            INSERT INTO payments (user_id, tx_hash, amount, status)
            VALUES ($1, $2, $3, 'pending')
            RETURNING *`;
        const { rows } = await pool.query(query, [userId, txHash, amount]);
        return rows[0];
    },

    async confirmPayment(txHash) {
        const query = `
            UPDATE payments 
            SET status = 'confirmed', 
                confirmed_at = CURRENT_TIMESTAMP
            WHERE tx_hash = $1
            RETURNING *`;
        const { rows } = await pool.query(query, [txHash]);
        return rows[0];
    },

    // Transaction operations
    async addTransaction(walletId, txHash, amount, direction, timestamp) {
        const query = `
            INSERT INTO transactions (wallet_id, tx_hash, amount, direction, timestamp)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (wallet_id, tx_hash) 
            DO UPDATE SET 
                amount = EXCLUDED.amount,
                direction = EXCLUDED.direction,
                timestamp = EXCLUDED.timestamp
            RETURNING *`;
        const { rows } = await pool.query(query, [walletId, txHash, amount, direction, timestamp]);
        return rows[0];
    }
};

module.exports = db;
