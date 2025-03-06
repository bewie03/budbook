-- Users table to store Google auth and payment info
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    payment_status BOOLEAN DEFAULT false,
    slot_count INTEGER DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Wallets table to store user's saved wallets
CREATE TABLE wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    address TEXT NOT NULL,
    stake_address TEXT,
    label TEXT,
    total_lovelace BIGINT DEFAULT 0,
    last_sync TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, address)
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
