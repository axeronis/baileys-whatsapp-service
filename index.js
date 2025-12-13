const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios'); // Add axios for webhooks

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'your-secret-key';

// Store sessions in memory
const sessions = new Map();
const msgRetryCounterCache = new Map();

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

        // Clean up any existing session properly
        if (sessions.has(instanceName)) {
            const existingSession = sessions.get(instanceName);
            if (existingSession.sock) {
                logger.info(`Instance ${instanceName} already exists, closing old connection`);
                try {
                    // Try to logout/end
                    existingSession.sock.end(new Error('Starting new session'));
                } catch (err) {
                    logger.warn(`Error closing old session: ${err.message}`);
                }
            }
            sessions.delete(instanceName);
        }

        // Delete old auth folder to force fresh QR generation if starting fresh
        const fs = require('fs');
        const authPath = `./auth_info_${instanceName}`;
        if (fs.existsSync(authPath)) {
            logger.info(`Deleting old auth folder: ${authPath}`);
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        // Create new auth state
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        let qrCodeResolve;
        let qrCodeReject;

        // Promise that resolves when first QR is generated (for API response)
        const qrCodePromise = new Promise((resolve, reject) => {
            qrCodeResolve = resolve;
            qrCodeReject = reject;
        });

        // Timeout to answer API call if QR takes too long
        const apiTimeout = setTimeout(() => {
            if (qrCodeReject) {
                logger.error(`QR timeout for ${instanceName} after 60s`);
                qrCodeReject(new Error('QR generation timeout'));
                qrCodeResolve = null;
                qrCodeReject = null;
            }
        }, 60000);

        // Recursive function to start/restart socket
        const startSock = async () => {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'info' }),
                browser: ['MicroFunnel Studio', 'Chrome', '1.0.0'], // Custom signature to reduce bans/disconnects
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false, // Disable to reduce resource load
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                retryRequestDelayMs: 2000, // Slightly faster retry
                syncFullHistory: false,
                msgRetryCounterCache,
                getMessage: async (key) => {
                    return { conversation: 'hello' };
                }
            });

            // Store socket in session immediately so we can close it later if needed
            // But be careful not to overwrite 'qrCode' property if it exists from previous run?
            // Actually, we should merge.
            let currentSession = sessions.get(instanceName) || { createdAt: new Date() };
            currentSession.sock = sock;
            sessions.set(instanceName, currentSession);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('messages.upsert', async (update) => {
                // Determine connection state from sessions or sock
                // Actually messages.upsert is separate from connection.update
                // We need to handle this event separately!
            });

            // We move the messages.upsert logic inside the startSock function scope, 
            // but we need to register it on sock.ev
            // The previous placement of connection.update was correct for connection events.
            // Let's add messages.upsert handler here.

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return; // Only process new messages

                for (const msg of messages) {
                    try {
                        if (!msg.message) continue;
                        if (msg.key.fromMe) continue; // Skip own messages

                        // Determine text content
                        const msgContent = msg.message.conversation || msg.message.extendedTextMessage?.text;
                        if (!msgContent) continue;

                        // Construct payload matching Evolution API format
                        const webhookPayload = {
                            type: "messages.upsert",
                            data: {
                                key: msg.key,
                                message: msg.message,
                                messageTimestamp: msg.messageTimestamp || Date.now() / 1000
                            }
                        };

                        // Extract tenant_id from instanceName (format: tenant_{uuid})
                        const tenantId = instanceName.replace('tenant_', '');

                        // Send to main backend
                        // Use internal docker network URL for backend
                        const backendUrl = process.env.BACKEND_URL || 'http://backend:8000';
                        const webhookUrl = `${backendUrl}/api/v1/webhook/evolution/${tenantId}`;

                        logger.info(`🔍 DEBUG WEBHOOK: instanceName=${instanceName}, tenantId=${tenantId}`);
                        logger.info(`🔗 Target URL: ${webhookUrl}`);
                        logger.info(`Forwarding message from ${msg.key.remoteJid} to ${webhookUrl}`);

                        // Fire and forget - don't await response to not block Baileys
                        axios.post(webhookUrl, webhookPayload).catch(err => {
                            logger.error(`Failed to forward webhook to backend: ${err.message}`);
                            if (err.response) {
                                logger.error(`Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
                            }
                            logger.error(`Config URL: ${err.config?.url}`);
                        });

                    } catch (err) {
                        logger.error(`Error processing incoming message: ${err.message}`);
                    }
                }
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // Handle QR
                if (qr) {
                    try {
                        const qrBase64 = await QRCode.toDataURL(qr);
                        logger.info(`QR Code generated for ${instanceName}`);

                        // Update session
                        const s = sessions.get(instanceName) || {};
                        s.qrCode = qrBase64;
                        s.qrRaw = qr;
                        s.qrGeneratedAt = Date.now();
                        s.isConnected = false;
                        sessions.set(instanceName, s);

                        // Resolve initial API promise if waiting
                        if (qrCodeResolve) {
                            clearTimeout(apiTimeout);
                            qrCodeResolve(qrBase64);
                            qrCodeResolve = null;
                            qrCodeReject = null;
                        }

                    } catch (err) {
                        logger.error(`QR generation error: ${err.message}`);
                    }
                }

                // Handle Connection Close / Reconnect
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    logger.error(`Connection closed for ${instanceName}. Status: ${statusCode}, Error: ${error?.message}`);

                    // 515 specifically needs a restart
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    if (shouldReconnect) {
                        if (statusCode === 515) {
                            logger.warn(`Stream Errored (515) for ${instanceName} - Executing auto-restart logic.`);
                        } else {
                            logger.info(`Reconnecting ${instanceName} (auto-restart logic)...`);
                        }
                        // Delay slightly to prevent tight loops
                        setTimeout(() => startSock(), 2000);
                    } else {
                        logger.info(`Session ${instanceName} logged out definitively`);
                        sessions.delete(instanceName);
                        // If we were waiting for QR, reject it
                        if (qrCodeReject) {
                            clearTimeout(apiTimeout);
                            qrCodeReject(new Error('Session logged out during startup'));
                        }
                    }
                }

                // Handle Connected
                else if (connection === 'open') {
                    logger.info(`WhatsApp connected for ${instanceName}`);
                    const s = sessions.get(instanceName);
                    if (s) {
                        s.isConnected = true;
                        s.qrCode = null;
                    }

                    // If we connected WITHOUT a QR (e.g. session restored), resolve promise too
                    if (qrCodeResolve) {
                        clearTimeout(apiTimeout);
                        // We resolve with null QR to indicate immediate connection? 
                        // Or just resolve with "connected"
                        // The API expects { instance, qrcode }. Content doesn't matter much if status is open.
                        qrCodeResolve(null); // Signal connected
                        qrCodeResolve = null;
                        qrCodeReject = null;
                    }
                }
            });
        };

        // Start the first socket
        await startSock();

        // Wait for result (QR or Connection)
        try {
            const qrResult = await qrCodePromise;

            // Check session status
            const finalSession = sessions.get(instanceName);
            const isConnected = finalSession?.isConnected || false;

            res.json({
                instance: {
                    instanceName,
                    status: isConnected ? 'open' : 'connecting'
                },
                qrcode: qrResult ? { base64: qrResult } : undefined
            });

        } catch (err) {
            res.status(500).json({ error: err.message });
        }

    } catch (error) {
        logger.error(`Error creating instance: ${error.message} `);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
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

        if (session) {
            try {
                // Try to close socket gracefully
                if (session.sock) {
                    // Start absolute timeout for logout to prevent hanging
                    const logoutPromise = session.sock.logout();
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Logout timed out')), 2000)
                    );

                    await Promise.race([logoutPromise, timeoutPromise]).catch(err => {
                        logger.warn(`Logout failed (ignoring): ${err.message}`);
                    });

                    // Safely terminate socket
                    if (session.sock.ws && typeof session.sock.ws.terminate === 'function') {
                        try {
                            session.sock.ws.terminate();
                        } catch (err) {
                            logger.warn(`Socket terminate failed: ${err.message}`);
                        }
                    }
                }
            } catch (err) {
                logger.warn(`Error closing socket for ${instanceName}: ${err.message}`);
            }
            sessions.delete(instanceName);
        }

        // Always try to clean up auth folder
        const fs = require('fs');
        const authPath = `./auth_info_${instanceName}`;
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                logger.info(`Deleted auth folder: ${authPath}`);
            } catch (err) {
                logger.error(`Failed to delete auth folder: ${err.message}`);
            }
        }

        res.json({ message: 'Instance deleted' });

    } catch (error) {
        logger.error(`Error deleting instance: ${error.message}`);
        // Even if error, return success to allow backend to retry/continue
        res.json({ message: 'Instance deletion attempted', error: error.message });
    }
});

// Send message
app.post('/message/sendText/:instanceName', authMiddleware, async (req, res) => {
    try {
        const { instanceName } = req.params;
        const body = req.body;

        // Handle both simple { number, text } and nested { textMessage: { text } } (Evolution API style)
        let number = body.number;
        let text = body.text;

        if (!text && body.textMessage && body.textMessage.text) {
            text = body.textMessage.text;
        }

        const session = sessions.get(instanceName);

        if (!session || !session.isConnected) {
            return res.status(400).json({ error: 'Instance not connected' });
        }

        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        logger.info(`Attempting to send message to ${jid} via ${instanceName}`);
        await session.sock.sendMessage(jid, { text });
        logger.info(`Message successfully sent to ${jid}`);

        res.json({ status: 'success', message: 'Message sent' });

    } catch (error) {
        logger.error(`Error sending message: ${error.message} `);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logger.info(`Baileys WhatsApp Service running on port ${PORT} `);
});
