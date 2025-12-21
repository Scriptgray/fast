import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// USER-AGENT DE ANDROID (CHROME) - INDISPENSABLE PARA EVITAR BLOQUEOS
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 240000, // 4 minutos para videos largos
}

// --- UTILIDADES ---
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

// --- SERVICIOS ---

const services = {
    // MÉTODO 1: SAVETUBE (AES DECRYPT)
    savetube: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        
        const headers = { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/json' };
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers });
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers });
        
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '480', key: dec.key
        }, { headers });

        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    },

    // MÉTODO 2: YTDOWN.TO (BACKUP PARA VIDEO)
    ytdown: async (url, isAudio) => {
        const { data: info } = await axios.post('https://ytdown.to/proxy.php', `url=${encodeURIComponent(url)}`, { 
            headers: { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/x-www-form-urlencoded' } 
        });
        const items = info.api?.mediaItems || [];
        const target = items.find(it => isAudio ? it.type === 'Audio' : it.mediaRes?.includes('480')) || items[0];
        if (!target?.mediaUrl) throw 'No media';
        return { download: target.mediaUrl, winner: 'Ytdown.to' };
    }
};

// --- FUNCIÓN DE CARRERA ---
async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio' : 'Video'}`));
    
    // Si es video, intentamos ambos en paralelo
    const tasks = [services.savetube(url, isAudio).catch(() => null)];
    if (!isAudio) tasks.push(services.ytdown(url, isAudio).catch(() => null));

    const results = await Promise.all(tasks);
    const winner = results.find(r => r && r.download);

    if (!winner) {
        console.error(colorize(`[ERROR] Ningún servicio pudo generar el link.`, true));
        return null;
    }

    console.log(colorize(`[ENVIADO] Link obtenido vía ${winner.winner}`));
    return { ...winner, title: winner.title || originalTitle };
}

// --- DESCARGA DE BUFFER (EL PUNTO CRÍTICO) ---
async function getBufferFromUrl(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': ANDROID_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Referer': 'https://yt.savetube.me/'
            },
            method: 'GET',
            redirect: 'follow'
        });

        if (!response.ok) throw `Error HTTP ${response.status}`;

        const buffer = await response.buffer();
        
        // Validación de tamaño (si pesa menos de 10KB es basura/bloqueo)
        if (buffer.length < 10240) {
            throw 'El archivo descargado es inválido o está bloqueado por el servidor.';
        }

        return buffer;
    } catch (e) {
        // Si falla, mandamos el error exacto para saber qué pasó
        console.error(colorize(`[ERROR] getBuffer falló: ${e}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
