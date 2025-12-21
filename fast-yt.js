import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- AGENT DE ANDROID ACTUALIZADO ---
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 180000, // 3 minutos para asegurar descargas pesadas
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

// --- SERVICIOS RE-OPTIMIZADOS ---

const services = {
    // SAVENOW: EL MEJOR PARA VIDEO (MP4 COMPLETO)
    savenow: async (url, isAudio) => {
        const apiKey = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
        // Para video intentamos 720p, si no 360p es el fallback automático del API
        const format = isAudio ? 'mp3' : '720'; 
        
        const init = await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(url)}&api=${apiKey}`, { 
            headers: { 'User-Agent': ANDROID_UA } 
        });
        const data = await init.json();
        if (!data.id) throw 'Error de inicialización';

        for (let i = 0; i < 15; i++) { // Más intentos para asegurar el merge
            await new Promise(r => setTimeout(r, 2000));
            const prog = await (await fetch(`https://p.savenow.to/api/progress?id=${data.id}`, { headers: { 'User-Agent': ANDROID_UA } })).json();
            if (prog.progress === 1000 && prog.download_url) {
                return { download: prog.download_url, winner: 'Savenow' };
            }
        }
        throw 'Savenow tardó demasiado';
    },

    // SAVETUBE: EXCELENTE PARA AUDIO RÁPIDO
    savetube: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        const headers = { 'user-agent': ANDROID_UA, 'content-type': 'application/json' };
        const { data: cdn } = await axios.get('https://media.savetube.me/api/random-cdn', { headers });
        const { data: infoRes } = await axios.post(`https://${cdn.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers });
        
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        const { data: dl } = await axios.post(`https://${cdn.cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '360', key: dec.key
        }, { headers });
        
        if (!dl.data?.downloadUrl) throw 'Link inválido';
        return { download: dl.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
};

// --- FUNCIÓN DE CARRERA ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] Procesando ${isAudio ? 'Audio' : 'Video (360p-720p)'}`));

    // Si es VIDEO, damos prioridad a Savenow por ser más fiable con el MP4 real
    const methods = isAudio 
        ? [services.savetube(url, isAudio), services.savenow(url, isAudio)]
        : [services.savenow(url, isAudio), services.savetube(url, isAudio)];

    for (let method of methods) {
        try {
            const result = await method;
            if (result && result.download) {
                console.log(colorize(`[ENVIADO] Éxito vía ${result.winner}`));
                return { ...result, title: result.title || originalTitle };
            }
        } catch (e) { continue; }
    }

    console.error(colorize(`[ERROR] Fallo total en todos los servicios.`, true));
    return null;
}

// --- DESCARGA DE BUFFER SEGURA ---

async function getBufferFromUrl(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': ANDROID_UA,
                'Accept': '*/*',
                'Referer': 'https://y2down.cc/'
            },
            redirect: 'follow', // Crucial para links de YouTube/Google
            timeout: CONFIG.BUFFER_TIMEOUT
        });

        if (!response.ok) throw `Error HTTP ${response.status}`;

        const buffer = await response.buffer();
        
        // Validación de tamaño: Menos de 100KB suele ser un error en video
        if (buffer.length < 102400 && url.includes('video')) {
            throw 'El archivo descargado está incompleto o es un error del servidor.';
        }

        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] ${e}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
