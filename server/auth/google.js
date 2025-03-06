const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const crypto = require('crypto');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const REQUIRED_ADA = 10;
const MAX_SLOTS = 100;

const auth = {
    async verifyGoogleToken(token) {
        try {
            const ticket = await client.verifyIdToken({
                idToken: token,
                audience: process.env.GOOGLE_CLIENT_ID
            });
            
            const payload = ticket.getPayload();
            const { sub: googleId, email } = payload;

            // Get or create user with 0 slots by default
            let user = await db.getUserByGoogleId(googleId);
            if (!user) {
                user = await db.createUser(googleId, email, {
                    payment_status: false,
                    slot_count: 0,
                    created_at: new Date(),
                    name: payload.name,
                    picture: payload.picture
                });
            }

            // Get user's payment status and slot info
            const userStatus = {
                id: user.id,
                googleId: user.google_id,
                email: user.email,
                name: user.name,
                picture: user.picture,
                paymentStatus: user.payment_status,
                slots: user.slot_count || 0,
                needsPayment: !user.payment_status,
                paymentAddress: process.env.PAYMENT_ADDRESS,
                requiredAmount: REQUIRED_ADA
            };

            return userStatus;
        } catch (error) {
            console.error('Error verifying Google token:', error);
            throw new Error('Invalid token');
        }
    },

    async generatePaymentId(userId) {
        try {
            // Generate a unique payment ID
            const paymentId = crypto.randomBytes(16).toString('hex');
            
            // Create pending payment record
            await db.query(`
                INSERT INTO payments (user_id, payment_id, amount, status)
                VALUES ($1, $2, $3, 'pending')
            `, [userId, paymentId, REQUIRED_ADA]);

            return {
                paymentId,
                paymentAddress: process.env.PAYMENT_ADDRESS,
                requiredAmount: 10
            };
        } catch (error) {
            console.error('Error generating payment ID:', error);
            throw new Error('Failed to generate payment ID');
        }
    },

    async checkPaymentStatus(userId) {
        try {
            const user = await db.query(`
                SELECT payment_status, slot_count
                FROM users
                WHERE id = $1
            `, [userId]);

            if (!user.rows[0]) {
                throw new Error('User not found');
            }

            return {
                paid: user.rows[0].payment_status,
                slots: user.rows[0].slot_count,
                canAddWallets: user.rows[0].payment_status // Only paid users can add wallets
            };
        } catch (error) {
            console.error('Error checking payment status:', error);
            throw new Error('Failed to check payment status');
        }
    },

    async verifyPayment(paymentId) {
        try {
            // Get payment record
            const payment = await db.query(`
                SELECT p.*, u.id as user_id
                FROM payments p
                JOIN users u ON p.user_id = u.id
                WHERE p.payment_id = $1 AND p.status = 'pending'
            `, [paymentId]);

            if (!payment.rows[0]) {
                throw new Error('Payment not found or already processed');
            }

            // Update user's payment status and slot count
            await db.query(`
                UPDATE users
                SET payment_status = true,
                    slot_count = MAX_SLOTS,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [payment.rows[0].user_id]);

            // Update payment status
            await db.query(`
                UPDATE payments
                SET status = 'confirmed',
                    confirmed_at = CURRENT_TIMESTAMP
                WHERE payment_id = $1
            `, [paymentId]);

            return {
                success: true,
                slots: MAX_SLOTS,
                message: 'Payment verified and slots updated'
            };
        } catch (error) {
            console.error('Error verifying payment:', error);
            throw new Error('Failed to verify payment');
        }
    }
};

module.exports = auth;
