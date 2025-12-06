const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'your-secret-key';

// Store sessions in memory
const sessions = new Map();

// Logger
const logger = pino({ level: 'info' });

// Auth middleware
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

// Create instance and generate QR
app.post('/instance/create', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.body;

        if (!instanceName) {
            return res.status(400).json({ error: 'instanceName is required' });
        }

        // Check if session already exists
        if (sessions.has(instanceName)) {
            const session = sessions.get(instanceName);

            // If already connected, return status
            if (session.isConnected) {
                return res.json({
                    instance: {
                        instanceName,
                        status: 'open'
                    },
                    message: 'Instance already connected'
                });
            }

            // If has QR, return it
            if (session.qrCode) {
                return res.json({
                    instance: {
                        instanceName,
                        status: 'connecting'
                    },
                    qrcode: {
                        base64: session.qrCode
                    }
                });
            }
        }

        // Check if instance already exists and clean up
        if (sessions.has(instanceName)) {
            const existingSession = sessions.get(instanceName);
            if (existingSession.socket) {
                logger.info(`Instance ${instanceName} already exists, closing old connection`);
                try {
                    await existingSession.socket.logout();
                } catch (err) {
                    logger.warn(`Error logging out old session: ${err.message}`);
                }
            }
            sessions.delete(instanceName);
        }

        // Delete old auth folder to force fresh QR generation
        const fs = require('fs');
        const authPath = `./auth_info_${instanceName}`;
        if (fs.existsSync(authPath)) {
            logger.info(`Deleting old auth folder: ${authPath}`);
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        // Create new session
        const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_${instanceName}`);

        let isConnected = false;
        let qrCodeResolve;
        let qrCodeReject;

        // Promise to wait for QR
        const qrCodePromise = new Promise((resolve, reject) => {
            qrCodeResolve = resolve;
            qrCodeReject = reject;
        });

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'info' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 5000
        });

        // Timeout for QR generation (60 seconds)
        const timeout = setTimeout(() => {
            logger.error(`QR timeout for ${instanceName} after 60s`);
            qrCodeReject(new Error('QR generation timeout'));
        }, 60000);

        // QR Code event
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            logger.info(`Connection update for ${instanceName}: ${JSON.stringify({ connection, hasQR: !!qr })}`);

            if (qr) {
                try {
                    // Generate QR code as base64
                    const qrBase64 = await QRCode.toDataURL(qr);
                    logger.info(`QR Code generated for ${instanceName}`);
                    clearTimeout(timeout);

                    // Store QR in session
                    const session = sessions.get(instanceName) || {};
                    session.qrCode = qrBase64;
                    session.qrRaw = qr;
                    session.qrGeneratedAt = Date.now();
                    sessions.set(instanceName, session);

                    qrCodeResolve(qrBase64);
                } catch (err) {
                    logger.error(`QR generation error: ${err.message} `);
                    qrCodeReject(err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const error = lastDisconnect?.error;

                logger.error(`Connection closed for ${instanceName}. Status: ${statusCode}, Error: ${error?.message}`);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    logger.info(`Reconnecting ${instanceName}...`);
                } else {
                    logger.info(`Session ${instanceName} logged out`);
                    sessions.delete(instanceName);
                }
            } else if (connection === 'open') {
                isConnected = true;
                logger.info(`WhatsApp connected for ${instanceName}`);

                // Update session
                const session = sessions.get(instanceName);
                if (session) {
                    session.isConnected = true;
                    session.qrCode = null; // Clear QR after connection
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Wait for QR code
        const qrCode = await qrCodePromise;

        // Store session
        sessions.set(instanceName, {
            sock,
            qrCode,
            isConnected,
            createdAt: new Date()
        });

        res.json({
            instance: {
                instanceName,
                status: isConnected ? 'open' : 'connecting'
            },
            qrcode: {
                base64: qrCode
            }
        });

    } catch (error) {
        logger.error(`Error creating instance: ${error.message} `);
        res.status(500).json({ error: error.message });
    }
});

// Get fresh QR code (for auto-refresh)
app.get('/instance/qr/:instanceName', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.params;

        const session = sessions.get(instanceName);

        if (!session) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        if (session.isConnected) {
            return res.json({
                status: 'connected',
                message: 'Instance already connected'
            });
        }

        // Return current QR if exists and not expired (60 seconds)
        if (session.qrCode && session.qrGeneratedAt) {
            const age = Date.now() - session.qrGeneratedAt;
            if (age < 60000) { // Less than 60 seconds
                return res.json({
                    qrcode: {
                        base64: session.qrCode
                    },
                    expiresIn: Math.floor((60000 - age) / 1000)
                });
            }
        }

        // QR expired or doesn't exist, need to regenerate
        // This happens automatically when WhatsApp sends new QR
        return res.json({
            status: 'waiting',
            message: 'Waiting for new QR code'
        });

    } catch (error) {
        logger.error(`Error getting QR: ${error.message} `);
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
        logger.error(`Error fetching instances: ${error.message} `);
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
        if (session.sock) {
            await session.sock.logout();
        }
        sessions.delete(instanceName);

        res.json({ message: 'Instance deleted' });

    } catch (error) {
        logger.error(`Error deleting instance: ${error.message} `);
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

        const jid = number.includes('@') ? number : `${number} @s.whatsapp.net`;

        await session.sock.sendMessage(jid, { text });

        res.json({ status: 'success', message: 'Message sent' });

    } catch (error) {
        logger.error(`Error sending message: ${error.message} `);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logger.info(`Baileys WhatsApp Service running on port ${PORT} `);
});
