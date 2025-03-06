const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

async function initializeDatabase() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        console.log('Reading schema file...');
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = await fs.readFile(schemaPath, 'utf8');

        console.log('Connecting to database...');
        const client = await pool.connect();

        try {
            console.log('Beginning transaction...');
            await client.query('BEGIN');

            console.log('Executing schema...');
            await client.query(schema);

            console.log('Committing transaction...');
            await client.query('COMMIT');

            console.log('Database initialization completed successfully!');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error during database initialization:', error);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Failed to initialize database:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run the initialization
initializeDatabase()
    .then(() => {
        console.log('Database setup completed.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Database setup failed:', error);
        process.exit(1);
    });
