import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- AGENT DE ANDROID REAL (SIMULACIÓN DE DISPOSITIVO MÓVIL) ---
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 150000, // 2.5 minutos para no cortar el envío
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

// --- SERVICIOS CON BYPASS DE BLOQUEO ---

const savetube = {
    headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://yt.savetube.me',
        'Referer': 'https://yt.savetube.me/',
        'User-Agent': ANDROID_UA,
        'Sec-Ch-Ua-Mobile': '?1',
        'Sec-Ch-Ua-Platform': '"Android"'
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        
        // 1. Obtener CDN aleatorio
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers });
        const cdn = cdnRes.cdn;

        // 2. Info y Desencriptado AES
        const { data: infoRes } = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        // 3. Descarga (Audio 128kbps para que no pese / Video 480p para estabilidad)
        const { data: dlRes } = await axios.post(`https://${cdn}/api/download`, {
            id, 
            downloadType: isAudio ? 'audio' : 'video', 
            quality: isAudio ? '128' : '480', 
            key: dec.key
        }, { headers: savetube.headers });

        if (!dlRes.data?.downloadUrl) throw 'Link Error';
        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
}

const ytmp3 = {
    // Refuerzo para audio ultrarrápido
    download: async (url) => {
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: { 'User-Agent': ANDROID_UA, 'Accept': 'application/json' } });
        if (!data.url) throw 'Fail';
        return { download: data.url, winner: 'Ytmp3.gg' };
    }
}

// --- CARRERA DE MÉTODOS ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio (128kbps)' : 'Video (480p)'}`));

    const tasks = [savetube.download(url, isAudio).catch(() => null)];
    if (isAudio) tasks.push(ytmp3.download(url).catch(() => null));

    try {
        // Ejecutamos en paralelo y tomamos el primero que no sea null
        const results = await Promise.all(tasks);
        const winner = results.find(r => r && r.download);

        if (!winner) throw 'Fallo total';
        
        console.log(colorize(`[ENVIADO] Canal: ${winner.winner}`));
        return { ...winner, title: winner.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] Los servicios están saturados.`, true));
        return null;
    }
}

// --- DESCARGA DE BUFFER SIN BLOQUEO ---

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': ANDROID_UA,
                'Accept': 'video/mp4,video/x-m4v,video/*,audio/mpeg,audio/*',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            redirect: 'follow'
        });

        if (!res.ok) throw `Status ${res.status}`;
        
        const buffer = await res.buffer();
        
        // Validación: El archivo debe ser real (mínimo 100KB para video, 50KB para audio)
        if (buffer.length < 51200) {
            throw 'El servidor envió un archivo vacío (Bloqueo de IP)';
        }
        
        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] Descarga fallida: ${e}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
