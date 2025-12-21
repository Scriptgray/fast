import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 120000 
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

const savetube = {
    headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://yt.savetube.me',
        'referer': 'https://yt.savetube.me/',
        'user-agent': ANDROID_UA
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        
        // 1. Obtener CDN
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers });
        const cdn = cdnRes.cdn;

        // 2. Obtener Info y Desencriptar
        const { data: infoRes } = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
        
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        // 3. Solicitar descarga (Audio 128kbps para peso bajo / Video 360-720p)
        const { data: dlRes } = await axios.post(`https://${cdn}/api/download`, {
            id, 
            downloadType: isAudio ? 'audio' : 'video', 
            quality: isAudio ? '128' : '720', // Savetube gestiona bien el merge en 720p
            key: dec.key
        }, { headers: savetube.headers });

        if (!dlRes.data?.downloadUrl) throw 'No Link';
        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
}

const y2down = {
    // Servicio alternativo ultra-rápido para MP3
    download: async (url, isAudio) => {
        if (!isAudio) throw 'Solo audio';
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: { 'User-Agent': ANDROID_UA } });
        if (!data.url) throw 'Fail';
        return { download: data.url, winner: 'Ytmp3.gg' };
    }
}

// --- LOGICA DE CARRERA ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio (Ligero)' : 'Video (MP4)'}`));

    // Lanzamos Savetube para ambos, Y2down solo para audio como refuerzo
    const tasks = [savetube.download(url, isAudio)];
    if (isAudio) tasks.push(y2down.download(url, isAudio));

    try {
        // Promise.any para que mande EN CUANTO responda el primero
        const result = await Promise.any(tasks);
        console.log(colorize(`[ENVIADO] Ganador: ${result.winner}`));
        return { ...result, title: result.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] No se pudo procesar el archivo.`, true));
        return null;
    }
}

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 'User-Agent': ANDROID_UA },
            redirect: 'follow'
        });
        if (!res.ok) throw `Status ${res.status}`;
        
        const buffer = await res.buffer();
        // Verificación de integridad: el archivo debe tener contenido
        if (buffer.length < 50000) throw 'Archivo corrupto o demasiado pequeño';
        
        return buffer;
    } catch (e) {
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
