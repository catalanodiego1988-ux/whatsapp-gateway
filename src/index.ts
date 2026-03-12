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
    
    const baseDir = path.join(process.cwd(), '.puppeteer', 'chrome');
    console.log('Buscando Chrome en base:', baseDir);
    
    if (!fs.existsSync(baseDir)) {
        console.log('Base de Chrome no existe:', baseDir);
        return undefined;
    }

    try {
        const versions = fs.readdirSync(baseDir);
        for (const v of versions) {
            const p = path.join(baseDir, v, 'chrome-linux64', 'chrome');
            if (fs.existsSync(p)) {
                console.log('Chrome encontrado dinámicamente en:', p);
                return p;
            }
        }
    } catch (err) {
        console.error('Error listando versiones de Chrome:', err);
    }
    
    console.log('No se encontró ningún ejecutable de Chrome en .puppeteer/chrome/');
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
let isAuthenticated = false;
let lastEvent = 'none';
let lastEventTime = new Date().toISOString();

const updateEvent = (event: string) => {
    lastEvent = event;
    lastEventTime = new Date().toISOString();
    console.log(`[Event Update] ${event} at ${lastEventTime}`);
};

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
    updateEvent('qr');
    console.log('QR generado: El usuario debe escanearlo.');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
    isAuthenticated = false;
});

client.on('authenticated', () => {
    updateEvent('authenticated');
    console.log('WhatsApp autenticado: El scan fue exitoso.');
    isAuthenticated = true;
    qrCodeData = null;
});

client.on('auth_failure', (msg) => {
    updateEvent('auth_failure');
    console.error('Error de autenticación:', msg);
    isAuthenticated = false;
});

client.on('ready', () => {
    updateEvent('ready');
    console.log('WhatsApp conectado y listo para enviar mensajes.');
    isReady = true;
    qrCodeData = null;
});

client.on('loading_screen', (percent, message) => {
    updateEvent(`loading: ${percent}% - ${message}`);
    console.log('Cargando WhatsApp:', percent, '%', message);
});

client.on('disconnected', (reason) => {
    updateEvent(`disconnected: ${reason}`);
    console.log('WhatsApp desconectado:', reason);
    isReady = false;
    isAuthenticated = false;
    qrCodeData = null;
});

const initializeClient = () => {
    updateEvent('initializing');
    console.log('Inicializando cliente WhatsApp (paciencia, puede tardar 1-2 minutos)...');
    client.initialize()
        .then(() => console.log('client.initialize() completado'))
        .catch(err => {
            updateEvent(`init_error: ${err.message}`);
            console.error('ERROR CRÍTICO INICIALIZANDO WHATSAPP:', err);
            setTimeout(() => {
                console.log('Reintentando inicialización...');
                initializeClient();
            }, 30000);
        });
};

initializeClient();

// ─── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        isReady, 
        isAuthenticated,
        hasQr: !!qrCodeData,
        lastEvent,
        lastEventTime
    });
});

// ─── GET /status ────────────────────────────────────────────────────────────
app.get('/status', authenticate, (req, res) => {
    res.json({ 
        isReady, 
        isAuthenticated,
        hasQr: !!qrCodeData,
        lastEvent,
        lastEventTime
    });
});

// ─── POST /reset ─────────────────────────────────────────────────────────────
app.post('/reset', authenticate, async (req, res) => {
    console.log('Reset solicitado...');
    updateEvent('manual_reset');
    try {
        await client.destroy();
        initializeClient();
        res.json({ success: true, message: 'Cliente reiniciado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al reiniciar cliente' });
    }
});

// ─── POST /logout ────────────────────────────────────────────────────────────
app.post('/logout', authenticate, async (req, res) => {
    console.log('Logout solicitado...');
    updateEvent('manual_logout');
    try {
        await client.logout();
        isReady = false;
        isAuthenticated = false;
        qrCodeData = null;
        res.json({ success: true, message: 'Sesión cerrada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
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
