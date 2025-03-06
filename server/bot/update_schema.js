const { Pool } = require('pg');

// Database connection URL
const DATABASE_URL = 'postgres://uam89u5aqt5tb:p5ef0f96239564543c045f8b500fb1ce361c25dc0b92f9e71d246f29a9a2786dd@c5hilnj7pn10vb.cluster-czrs8kj4isg7.us-east-1.rds.amazonaws.com:5432/d1luaglokat67a';

// Create a connection pool
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Schema definition
const schema = `
-- Drop existing tables if they exist
DROP TABLE IF EXISTS transaction_outputs CASCADE;
DROP TABLE IF EXISTS transaction_inputs CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS asset_metadata_cache CASCADE;
DROP TABLE IF EXISTS staking_pools CASCADE;
DROP TABLE IF EXISTS wallet_rewards CASCADE;
DROP TABLE IF EXISTS wallet_delegations CASCADE;

-- Users table to store Google auth and payment info
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    payment_status BOOLEAN DEFAULT false,
    slot_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Staking pools table
CREATE TABLE staking_pools (
    id SERIAL PRIMARY KEY,
    pool_id TEXT NOT NULL,
    hex TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    blocks_minted BIGINT DEFAULT 0,
    live_stake BIGINT,
    live_delegators INTEGER,
    active_stake BIGINT,
    declared_pledge BIGINT,
    live_pledge BIGINT,
    margin_cost DECIMAL,
    fixed_cost BIGINT,
    reward_account TEXT,
    owners TEXT[],
    registration TEXT[],
    retirement TEXT[],
    metadata JSONB,
    relays JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pool_id)
);

-- Wallets table to store user's saved wallets
CREATE TABLE wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    address TEXT NOT NULL,
    stake_address TEXT,
    label TEXT,
    total_lovelace BIGINT DEFAULT 0,
    last_balance_lovelace BIGINT DEFAULT 0,
    balance_last_updated TIMESTAMP WITH TIME ZONE,
    delegated_pool_id TEXT REFERENCES staking_pools(pool_id),
    delegation_active_epoch INTEGER,
    total_rewards_earned BIGINT DEFAULT 0,
    last_reward_epoch INTEGER,
    last_reward_amount BIGINT DEFAULT 0,
    withdrawable_rewards BIGINT DEFAULT 0,
    last_sync TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, address)
);

-- Wallet rewards history
CREATE TABLE wallet_rewards (
    id SERIAL PRIMARY KEY,
    wallet_id INTEGER REFERENCES wallets(id),
    epoch INTEGER NOT NULL,
    amount BIGINT NOT NULL,
    pool_id TEXT REFERENCES staking_pools(pool_id),
    type TEXT CHECK (type IN ('member', 'leader', 'pool_deposit_refund')),
    spendable_epoch INTEGER,
    earned_at TIMESTAMP WITH TIME ZONE,
    withdrawn_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_id, epoch)
);

-- Wallet delegation history
CREATE TABLE wallet_delegations (
    id SERIAL PRIMARY KEY,
    wallet_id INTEGER REFERENCES wallets(id),
    pool_id TEXT REFERENCES staking_pools(pool_id),
    active_epoch INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    amount BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_id, active_epoch)
);

-- Assets table with comprehensive metadata
CREATE TABLE assets (
    id SERIAL PRIMARY KEY,
    wallet_id INTEGER REFERENCES wallets(id),
    policy_id TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    asset_name_ascii TEXT,
    fingerprint TEXT,
    quantity BIGINT NOT NULL,
    decimals INTEGER DEFAULT 0,
    has_nft_onchain_metadata BOOLEAN DEFAULT false,
    initial_mint_tx_hash TEXT,
    mint_or_burn_count INTEGER DEFAULT 0,
    onchain_metadata JSONB,
    onchain_metadata_standard TEXT,
    onchain_metadata_extra JSONB,
    image_url TEXT,
    ipfs_gateway_url TEXT,
    ipfs_hash TEXT,
    media_type TEXT,
    token_registry_metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_id, policy_id, asset_name)
);

-- Transactions table with detailed info
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    wallet_id INTEGER REFERENCES wallets(id),
    tx_hash TEXT NOT NULL,
    block_height BIGINT,
    block_time TIMESTAMP WITH TIME ZONE,
    slot BIGINT,
    index INTEGER,
    total_output TEXT,
    fee TEXT,
    deposit TEXT,
    size INTEGER,
    invalid_before TEXT,
    invalid_after TEXT,
    collateral_inputs JSONB,
    collateral_outputs JSONB,
    reference_inputs JSONB,
    direction TEXT CHECK (direction IN ('in', 'out')),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(wallet_id, tx_hash)
);

-- Transaction inputs table
CREATE TABLE transaction_inputs (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER REFERENCES transactions(id),
    tx_hash TEXT NOT NULL,
    output_index INTEGER,
    address TEXT,
    amount JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Transaction outputs table
CREATE TABLE transaction_outputs (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER REFERENCES transactions(id),
    tx_hash TEXT NOT NULL,
    output_index INTEGER,
    address TEXT,
    amount JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Payment tracking table
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    tx_hash TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    status TEXT CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE
);

-- Asset metadata cache table
CREATE TABLE asset_metadata_cache (
    id SERIAL PRIMARY KEY,
    policy_id TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    metadata JSONB,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(policy_id, asset_name)
);

-- Additional indexes for staking and rewards
CREATE INDEX idx_staking_pools_pool_id ON staking_pools(pool_id);
CREATE INDEX idx_wallet_rewards_wallet_id ON wallet_rewards(wallet_id);
CREATE INDEX idx_wallet_rewards_epoch ON wallet_rewards(epoch);
CREATE INDEX idx_wallet_delegations_wallet_id ON wallet_delegations(wallet_id);
CREATE INDEX idx_wallet_delegations_pool_id ON wallet_delegations(pool_id);
CREATE INDEX idx_wallets_stake_address_balance ON wallets(stake_address, last_balance_lovelace);

-- Create indexes for performance
CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallets_stake_address ON wallets(stake_address);
CREATE INDEX idx_assets_wallet_id ON assets(wallet_id);
CREATE INDEX idx_assets_policy_id ON assets(policy_id);
CREATE INDEX idx_assets_fingerprint ON assets(fingerprint);
CREATE INDEX idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX idx_transactions_tx_hash ON transactions(tx_hash);
CREATE INDEX idx_transaction_inputs_tx_hash ON transaction_inputs(tx_hash);
CREATE INDEX idx_transaction_outputs_tx_hash ON transaction_outputs(tx_hash);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_asset_metadata_policy_id_asset_name ON asset_metadata_cache(policy_id, asset_name);

-- Create function to update wallet timestamps
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers to automatically update timestamps
CREATE TRIGGER update_users_timestamp
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_assets_timestamp
    BEFORE UPDATE ON assets
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Create triggers for staking pools
CREATE TRIGGER update_staking_pools_timestamp
    BEFORE UPDATE ON staking_pools
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();

-- Create function to update wallet rewards
CREATE OR REPLACE FUNCTION update_wallet_rewards()
RETURNS TRIGGER AS $$
BEGIN
    -- Update total rewards in wallet when a new reward is added
    UPDATE wallets
    SET total_rewards_earned = total_rewards_earned + NEW.amount,
        last_reward_epoch = NEW.epoch,
        last_reward_amount = NEW.amount,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.wallet_id;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for wallet rewards
CREATE TRIGGER update_wallet_total_rewards
    AFTER INSERT ON wallet_rewards
    FOR EACH ROW
    EXECUTE FUNCTION update_wallet_rewards();
`;

async function updateSchema() {
    const client = await pool.connect();
    try {
        console.log('Starting schema update...');
        
        // Begin transaction
        await client.query('BEGIN');
        
        // Execute schema
        await client.query(schema);
        
        // Commit transaction
        await client.query('COMMIT');
        
        console.log('Schema update completed successfully!');
    } catch (error) {
        // Rollback on error
        await client.query('ROLLBACK');
        console.error('Error updating schema:', error);
        throw error;
    } finally {
        // Release client back to pool
        client.release();
        // Close pool
        await pool.end();
    }
}

// Run the update
console.log('Connecting to database...');
updateSchema()
    .then(() => {
        console.log('Database schema updated successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('Failed to update database schema:', error);
        process.exit(1);
    });
