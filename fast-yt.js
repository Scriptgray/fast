import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- ROTACIÓN DE DISPOSITIVOS PARA EVITAR BLOQUEOS ---
const AGENTS = [
    'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36', // Android
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', // iPhone
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36' // Windows
];

const CONFIG = {
    MAX_RETRIES: 3,
    BUFFER_TIMEOUT: 60000,
    MAX_FILENAME_LENGTH: 50
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', fg: { cyan: '\x1b[36m', red: '\x1b[31m', white: '\x1b[37m' } };
    let prefix = '', colorCode = codes.fg.cyan;
    if (text.startsWith('[BUSCANDO]')) prefix = '[BUSCANDO]';
    else if (text.startsWith('[ENVIADO]')) prefix = '[ENVIADO]';
    else if (isError || text.startsWith('[ERROR]')) { prefix = '[ERROR]'; colorCode = codes.fg.red; }
    else return `${codes.fg.white}${text}${codes.reset}`;
    const body = text.substring(prefix.length).trim();
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`;
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH);
}

// --- SERVICIO SAVETUBE (ESTRUCTURA ORIGINAL OPTIMIZADA) ---
const savetube = {
    headers: (agent) => ({
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://yt.savetube.me',
        'referer': 'https://yt.savetube.me/',
        'user-agent': agent
    }),
    decrypt: (enc) => {
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const data = Buffer.from(enc, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), data.slice(0, 16));
        const decrypted = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
        return JSON.parse(decrypted.toString());
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        
        const agent = AGENTS[0];
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers(agent) });
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers(agent) });
        const info = savetube.decrypt(infoRes.data);

        // Audio 128 (rápido) | Video 480 (estable y con audio incluido)
        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '480', key: info.key
        }, { headers: savetube.headers(agent) });

        if (!dlRes.data?.downloadUrl) throw new Error('No download URL');
        return { download: dlRes.data.downloadUrl, title: info.title, winner: 'Savetube' };
    }
};

// --- LOGICA DE CARRERA ---
async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio MP3' : 'Video MP4'}`));
    try {
        const res = await savetube.download(url, isAudio);
        console.log(colorize(`[ENVIADO] Canal: ${res.winner}`));
        return { ...res, title: res.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] Fallo en servicio: ${e.message}`, true));
        return null;
    }
}

// --- GETBUFFER CON ROTACIÓN DE AGENTS (SOLUCIÓN DEFINITIVA) ---
async function getBufferFromUrl(url) {
    let lastError;
    
    // Intenta descargar el archivo rotando entre Android, iPhone y Windows
    for (let i = 0; i < AGENTS.length; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': AGENTS[i],
                    'Accept': '*/*',
                    'Referer': 'https://yt.savetube.me/',
                    'Connection': 'keep-alive'
                },
                redirect: 'follow',
                timeout: CONFIG.BUFFER_TIMEOUT
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const buffer = await res.buffer();
            
            // Si el buffer es muy pequeño, es un error del servidor (bloqueo)
            if (buffer.length < 50000 && !url.includes('audio')) {
                throw new Error("Archivo incompleto (Bloqueo de IP)");
            }
            
            return buffer; 
        } catch (e) {
            lastError = e;
            console.log(colorize(`[ERROR] Intento ${i+1} fallido. Probando con otro dispositivo...`));
            await new Promise(r => setTimeout(r, 1500)); 
        }
    }
    
    throw new Error(`No se pudo obtener el archivo después de 3 intentos: ${lastError.message}`);
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
