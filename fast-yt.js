import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- SIMULACIÓN DE ANDROID (CHROME) ---
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 15000,
    MAX_FILENAME_LENGTH: 50,
    // Tiempos ajustados para asegurar que el archivo se genere bien
    RACE_TIMEOUT: 25000,
    BUFFER_TIMEOUT: 60000 
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

// --- SERVICIOS CON CABECERAS DE ANDROID ---

const savetube = {
    headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://yt.savetube.me',
        'referer': 'https://yt.savetube.me/',
        'user-agent': ANDROID_UA
    },
    decrypt: (enc) => {
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const data = Buffer.from(enc, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), data.slice(0, 16));
        const decrypted = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
        return JSON.parse(decrypted.toString());
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers });
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
        const info = savetube.decrypt(infoRes.data);
        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '720', key: info.key
        }, { headers: savetube.headers });
        if (!dlRes.data?.downloadUrl) throw 'Error link';
        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: info.title };
    }
};

const ytdown = {
    download: async (url, isAudio) => {
        const headers = { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/x-www-form-urlencoded' };
        const { data: info } = await axios.post('https://ytdown.to/proxy.php', `url=${encodeURIComponent(url)}`, { headers });
        const items = info.api?.mediaItems || [];
        const best = items.find(it => isAudio ? it.type === 'Audio' : it.mediaRes?.includes('720')) || items[0];
        if (!best?.mediaUrl) throw 'No media';
        return { download: best.mediaUrl, winner: 'Ytdown.to' };
    }
};

const ytmp3 = {
    download: async (url) => {
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: { 'User-Agent': ANDROID_UA } });
        if (!data.url) throw 'Fail';
        return { download: data.url, winner: 'Ytmp3.gg' };
    }
};

// --- LOGICA DE ENVÍO Y CARRERA ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio' : 'Video'} → ${originalTitle}`));

    const promises = [
        savetube.download(url, isAudio).catch(() => null),
        ytdown.download(url, isAudio).catch(() => null)
    ];
    if (isAudio) promises.push(ytmp3.download(url).catch(() => null));

    // Esperamos a la primera que responda BIEN
    const results = await Promise.all(promises);
    const winner = results.find(r => r && r.download);

    if (!winner) {
        console.error(colorize(`[ERROR] No se pudo obtener enlace válido de ningún servicio.`, true));
        return null;
    }

    console.log(colorize(`[ENVIADO] Éxito vía ${winner.winner}`));
    return { ...winner, title: winner.title || originalTitle };
}

async function getBufferFromUrl(url) {
    try {
        // MUY IMPORTANTE: Se añade el User-Agent también al descargar el archivo
        // Esto evita que mande archivos de 0kb o corruptos.
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': ANDROID_UA,
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            timeout: CONFIG.BUFFER_TIMEOUT 
        });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const buffer = await res.buffer();
        if (buffer.length < 1000) throw new Error("Archivo demasiado pequeño/corrupto");
        
        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] Error al descargar buffer: ${e.message}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
