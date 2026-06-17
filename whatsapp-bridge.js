const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const port = Number(process.env.LEADTRACKER_WA_PORT || 3030);
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let qrDataUrl = '';
let status = 'starting';
let statusMessage = 'Starting WhatsApp bridge...';
let connectedNumber = '';
let lastError = '';

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'leadtracker' }),
    puppeteer: {
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    },
});

client.on('qr', async (qr) => {
    status = 'qr';
    statusMessage = 'Scan this QR with WhatsApp on your phone.';
    connectedNumber = '';
    qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
});

client.on('authenticated', () => {
    status = 'authenticated';
    statusMessage = 'Authenticated. Finishing connection...';
});

client.on('ready', async () => {
    status = 'ready';
    statusMessage = 'Connected. LeadTracker can send WhatsApp messages.';
    qrDataUrl = '';
    try {
        const info = client.info || {};
        connectedNumber = info.wid && info.wid.user ? info.wid.user : '';
    } catch (error) {
        connectedNumber = '';
    }
});

client.on('auth_failure', (message) => {
    status = 'auth_failure';
    statusMessage = 'WhatsApp authentication failed. Restart the bridge and scan again.';
    lastError = String(message || '');
});

client.on('disconnected', (reason) => {
    status = 'disconnected';
    statusMessage = 'WhatsApp disconnected. Restart the bridge if it does not reconnect.';
    connectedNumber = '';
    lastError = String(reason || '');
});

client.initialize().catch((error) => {
    status = 'error';
    statusMessage = 'Could not start WhatsApp bridge.';
    lastError = error && error.message ? error.message : String(error);
    console.error(error);
});

function normalizePhone(phone) {
    let digits = String(phone || '').replace(/\D+/g, '');
    if (digits.startsWith('00')) {
        digits = digits.slice(2);
    }
    if (digits.startsWith('0')) {
        digits = `6${digits}`;
    }
    if (digits.startsWith('1')) {
        digits = `60${digits}`;
    }
    return digits;
}

app.get('/status', (req, res) => {
    res.json({
        ok: true,
        status,
        statusMessage,
        qrDataUrl,
        connectedNumber,
        lastError,
    });
});

app.post('/send', async (req, res) => {
    if (status !== 'ready') {
        res.status(409).json({ ok: false, error: 'WhatsApp is not connected yet.' });
        return;
    }

    const phone = normalizePhone(req.body.phone);
    const message = String(req.body.message || '').trim();

    if (!/^60\d{8,11}$/.test(phone)) {
        res.status(422).json({ ok: false, error: 'Invalid Malaysia phone number.' });
        return;
    }

    if (message === '') {
        res.status(422).json({ ok: false, error: 'Message is required.' });
        return;
    }

    try {
        await client.sendMessage(`${phone}@c.us`, message);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error && error.message ? error.message : 'Could not send message.',
        });
    }
});

app.listen(port, '127.0.0.1', () => {
    console.log(`LeadTracker WhatsApp bridge running at http://127.0.0.1:${port}`);
});
