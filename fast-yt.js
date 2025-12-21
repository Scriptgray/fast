import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- AGENT DE ANDROID (FIREFOX/CHROME MOBILE) ---
const ANDROID_UA = 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/114.0 Firefox/114.0';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    REQUEST_TIMEOUT: 20000,
    BUFFER_TIMEOUT: 120000 // 2 minutos para videos pesados
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

// --- SERVICIOS CORREGIDOS PARA VIDEO REAL ---

const services = {
    // Savenow: Es el mejor para VIDEO porque entrega MP4 con audio incluido
    savenow: async (url, isAudio) => {
        const apiKey = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
        const format = isAudio ? 'mp3' : '360'; // 360/720 para máxima compatibilidad de buffer
        const init = await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(url)}&api=${apiKey}`, { headers: { 'User-Agent': ANDROID_UA } });
        const data = await init.json();
        
        if (!data.id) throw 'Error inicial';
        
        // Esperar a que el servidor procese el video real
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const prog = await (await fetch(`https://p.savenow.to/api/progress?id=${data.id}`, { headers: { 'User-Agent': ANDROID_UA } })).json();
            if (prog.progress === 1000 && prog.download_url) {
                return { download: prog.download_url, winner: 'Savenow' };
            }
        }
        throw 'Timeout procesado';
    },

    // Savetube: Muy rápido para AUDIO
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
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '480', key: dec.key
        }, { headers });
        
        return { download: dl.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
};

// --- CARRERA CON PRIORIDAD ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] Solicitando ${isAudio ? 'Audio' : 'Video'}`));

    try {
        // Para VIDEO, Savenow es más lento pero SEGURO. Savetube es rápido pero a veces falla en video.
        // Lanzamos ambos; el primero que resuelva con un archivo válido gana.
        const tasks = [
            services.savetube(url, isAudio).catch(() => null),
            services.savenow(url, isAudio).catch(() => null)
        ];

        const results = await Promise.all(tasks);
        const winner = results.find(r => r && r.download);

        if (!winner) throw 'No result';

        console.log(colorize(`[ENVIADO] Canal: ${winner.winner}`));
        return { ...winner, title: winner.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] No se pudo obtener enlace reproducible.`, true));
        return null;
    }
}

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': ANDROID_UA,
                'Accept': 'video/mp4,video/x-m4v,video/*;q=0.9,audio/mpeg,audio/*;q=0.8'
            },
            timeout: CONFIG.BUFFER_TIMEOUT 
        });
        
        if (!res.ok) throw `Status ${res.status}`;
        
        const buffer = await res.buffer();
        // Si el buffer es menor a 50KB, es un error del servidor, no un video.
        if (buffer.length < 51200) throw 'Archivo inválido (muy pequeño)';
        
        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] El archivo no se pudo descargar correctamente: ${e}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
