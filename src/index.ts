import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { Client, LocalAuth } from 'whatsapp-web.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// Helper para encontrar el ejecutable de Chrome en Render o Local
const getExecutablePath = () => {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        console.log('Usando PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    // Ruta estándar con ./.puppeteer como cache
    const chromePath = path.join(process.cwd(), '.puppeteer', 'chrome', 'linux-146.0.7680.66', 'chrome-linux64', 'chrome');
    console.log('Buscando Chrome en:', chromePath);
    
    if (fs.existsSync(chromePath)) {
        console.log('Chrome encontrado!');
        return chromePath;
    }
    
    console.log('Chrome NO encontrado en ruta relativa.');
    return undefined;
};

const app = express();
app.use(express.json());
app.use(cors());

// ─── Autenticación ──────────────────────────────────────────────────────────
const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const secret = req.headers['x-gateway-secret'];
    if (secret !== process.env.GATEWAY_SECRET) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
};

// ─── Estado global ──────────────────────────────────────────────────────────
let qrCodeData: string | null = null;
let isReady = false;

// ─── Cliente WhatsApp ───────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        executablePath: getExecutablePath(),
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
    }
});

client.on('qr', async (qr) => {
    console.log('QR generado');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
});

client.on('authenticated', () => {
    console.log('WhatsApp autenticado');
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación:', msg);
});

client.on('ready', () => {
    console.log('WhatsApp conectado');
    isReady = true;
    qrCodeData = null;
});

client.on('loading_screen', (percent, message) => {
    console.log('Cargando WhatsApp:', percent, '%', message);
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp desconectado:', reason);
    isReady = false;
    qrCodeData = null;
});

console.log('Inicializando cliente WhatsApp...');
client.initialize().catch(err => console.error('Error inicializando:', err));

// ─── Endpoint de salud — necesario para que Render no apague el servicio ───
app.get('/health', (req, res) => {
    res.json({ status: 'ok', isReady, hasQr: !!qrCodeData });
});

// ─── GET /status ────────────────────────────────────────────────────────────
app.get('/status', authenticate, (req, res) => {
    res.json({ isReady, hasQr: !!qrCodeData });
});

// ─── GET /qr ────────────────────────────────────────────────────────────────
app.get('/qr', authenticate, (req, res) => {
    if (!qrCodeData) {
        return res.status(404).json({
            error: isReady ? 'Ya conectado' : 'QR no disponible aún, esperá unos segundos'
        });
    }
    res.json({ qr: qrCodeData });
});

// ─── POST /send ─────────────────────────────────────────────────────────────
app.post('/send', authenticate, async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp no está conectado' });
    }

    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone y message son requeridos' });
    }

    try {
        const formattedPhone = phone.replace(/\D/g, '') + '@c.us';
        await client.sendMessage(formattedPhone, message);
        res.json({ success: true });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        res.status(500).json({ error: 'Error enviando mensaje' });
    }
});

// ─── POST /broadcast ────────────────────────────────────────────────────────
app.post('/broadcast', authenticate, async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp no está conectado' });
    }

    const { contacts, message } = req.body;
    if (!contacts || !Array.isArray(contacts) || !message) {
        return res.status(400).json({ error: 'contacts (array) y message son requeridos' });
    }

    res.json({ success: true, total: contacts.length, message: 'Broadcast iniciado' });

    (async () => {
        for (const contact of contacts) {
            try {
                const formattedPhone = contact.phone.replace(/\D/g, '') + '@c.us';
                const personalizedMessage = message.replace('{name}', contact.name || '');
                await client.sendMessage(formattedPhone, personalizedMessage);
                console.log(`Enviado a ${contact.phone}`);
            } catch (error) {
                console.error(`Error enviando a ${contact.phone}:`, error);
            }
            // Delay 2-4 segundos entre mensajes
            const delay = 2000 + Math.random() * 2000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        console.log('Broadcast completado');
    })();
});

// ─── Iniciar servidor ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Gateway corriendo en puerto ${PORT}`);
});
