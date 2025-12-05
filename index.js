const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, usePairingCode } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'your-secret-key';

// Store sessions in memory
const sessions = new Map();
const pairingCodes = new Map();

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

// Request pairing code
app.post('/instance/create', authMiddleware, async (req, res) => {
    try {
        const { instanceName, phoneNumber } = req.body;

        if (!instanceName) {
            return res.status(400).json({ error: 'instanceName is required' });
        }

        if (!phoneNumber) {
            return res.status(400).json({ error: 'phoneNumber is required' });
        }

        // Check if session already exists
        if (sessions.has(instanceName)) {
            return res.status(403).json({ error: 'Instance already exists' });
        }

        // Create session
        const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_${instanceName}`);

        let isConnected = false;
        let pairingCode = null;

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        // Request pairing code
        if (!sock.authState.creds.registered) {
            // Clean phone number (remove spaces, dashes, etc)
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

            // Request pairing code
            pairingCode = await sock.requestPairingCode(cleanNumber);

            logger.info(`Pairing code generated for ${instanceName}: ${pairingCode}`);
        }

        // Connection events
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    logger.info(`Reconnecting ${instanceName}...`);
                } else {
                    logger.info(`Session ${instanceName} logged out`);
                    sessions.delete(instanceName);
                    pairingCodes.delete(instanceName);
                }
            } else if (connection === 'open') {
                isConnected = true;
                logger.info(`WhatsApp connected for ${instanceName}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Store session
        sessions.set(instanceName, {
            sock,
            isConnected,
            phoneNumber: cleanNumber,
            createdAt: new Date()
        });

        if (pairingCode) {
            pairingCodes.set(instanceName, pairingCode);
        }

        res.json({
            instance: {
                instanceName,
                status: isConnected ? 'open' : 'connecting',
                phoneNumber: cleanNumber
            },
            pairingCode: pairingCode || null
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
                phoneNumber: data.phoneNumber,
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
            phoneNumber: session.phoneNumber,
            pairingCode: pairingCodes.get(instanceName),
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
        pairingCodes.delete(instanceName);

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
