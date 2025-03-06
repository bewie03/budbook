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

async function updateSlotDefaults() {
    const client = await pool.connect();
    try {
        console.log('Starting slot update...');
        
        await client.query('BEGIN');

        // Update existing users table to change default
        await client.query(`
            ALTER TABLE users 
            ALTER COLUMN slot_count SET DEFAULT 0;
        `);

        // Update all existing users to have 0 slots unless they've paid
        await client.query(`
            UPDATE users 
            SET slot_count = CASE 
                WHEN payment_status = true THEN 100 
                ELSE 0 
            END;
        `);

        await client.query('COMMIT');
        console.log('Slot update completed successfully!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating slots:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the update
console.log('Connecting to database...');
updateSlotDefaults()
    .then(() => {
        console.log('Slot defaults updated successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('Failed to update slot defaults:', error);
        process.exit(1);
    });
