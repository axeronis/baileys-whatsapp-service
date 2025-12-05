const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'your-secret-key';

// Store sessions in memory (in production, use Redis/database)
const sessions = new Map();

// Logger
const logger = pino({ level: 'info' });

// Middleware для проверки API ключа
function authMiddleware(req, res, next) {
    const apiKey = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size });
});

// Generate QR Code
app.post('/instance/create', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.body;

        if (!instanceName) {
            return res.status(400).json({ error: 'instanceName is required' });
        }

        // Check if session already exists
        if (sessions.has(instanceName)) {
            return res.status(403).json({ error: 'Instance already exists' });
        }

        // Create session
        const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_${instanceName}`);

        let isConnected = false;

        // Create Promise to wait for QR
        const qrCodePromise = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn(`QR timeout for ${instanceName}`);
                resolve(null);
            }, 15000); // 15 second timeout

            const sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' })
            });

            // QR Code event
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    // Generate QR code as base64
                    const qrBase64 = await QRCode.toDataURL(qr);
                    logger.info(`QR Code generated for ${instanceName}`);
                    clearTimeout(timeout);
                    resolve({ sock, qrCode: qrBase64 });
                }

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

                    if (shouldReconnect) {
                        logger.info(`Reconnecting ${instanceName}...`);
                    } else {
                        logger.info(`Session ${instanceName} logged out`);
                        sessions.delete(instanceName);
                    }
                } else if (connection === 'open') {
                    isConnected = true;
                    logger.info(`WhatsApp connected for ${instanceName}`);
                }
            });

            sock.ev.on('creds.update', saveCreds);
        });

        // Wait for QR code
        const result = await qrCodePromise;

        if (!result || !result.qrCode) {
            return res.status(500).json({ error: 'Failed to generate QR code' });
        }

        // Store session
        sessions.set(instanceName, {
            sock: result.sock,
            qrCode: result.qrCode,
            isConnected,
            createdAt: new Date()
        });

        res.json({
            instance: {
                instanceName,
                status: isConnected ? 'open' : 'connecting'
            },
            qrcode: {
                base64: result.qrCode
            }
        });

    } catch (error) {
        logger.error(`Error creating instance: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Get instance status
app.get('/instance/fetchInstances', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.query;

        if (!instanceName) {
            // Return all instances
            const allInstances = Array.from(sessions.entries()).map(([name, data]) => ({
                name,
                connectionStatus: data.isConnected ? 'open' : 'close',
                createdAt: data.createdAt
            }));
            return res.json(allInstances);
        }

        const session = sessions.get(instanceName);

        if (!session) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        res.json([{
            name: instanceName,
            connectionStatus: session.isConnected ? 'open' : 'close',
            qrcode: session.qrCode,
            createdAt: session.createdAt
        }]);

    } catch (error) {
        logger.error(`Error fetching instances: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Delete instance
app.delete('/instance/delete/:instanceName', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.params;

        const session = sessions.get(instanceName);

        if (!session) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        // Close socket
        await session.sock.logout();
        sessions.delete(instanceName);

        res.json({ message: 'Instance deleted' });

    } catch (error) {
        logger.error(`Error deleting instance: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Send message
app.post('/message/sendText/:instanceName', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.params;
        const { number, text } = req.body;

        const session = sessions.get(instanceName);

        if (!session || !session.isConnected) {
            return res.status(400).json({ error: 'Instance not connected' });
        }

        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        await session.sock.sendMessage(jid, { text });

        res.json({ status: 'success', message: 'Message sent' });

    } catch (error) {
        logger.error(`Error sending message: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logger.info(`Baileys WhatsApp Service running on port ${PORT}`);
});
