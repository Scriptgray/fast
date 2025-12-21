import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// AGENT QUE SIMULA ANDROID CHROME PERFECTAMENTE
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 180000, 
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

// SERVICIOS
const savetube = {
    headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://yt.savetube.me',
        'Referer': 'https://yt.savetube.me/',
        'User-Agent': ANDROID_UA
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers });
        const cdn = cdnRes.cdn;

        const { data: infoRes } = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        // Calidad 360p o 480p para asegurar que el archivo sea VÁLIDO y no requiera unión manual
        const quality = isAudio ? '128' : '480'; 

        const { data: dlRes } = await axios.post(`https://${cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality, key: dec.key
        }, { headers: savetube.headers });

        if (!dlRes.data?.downloadUrl) throw 'Link Error';
        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
}

// CARRERA DINÁMICA
async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio' : 'Video (MP4 Progresivo)'}`));
    try {
        const result = await savetube.download(url, isAudio);
        console.log(colorize(`[ENVIADO] Éxito vía Savetube`));
        return { ...result, title: result.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] No se pudo obtener el video.`, true));
        return null;
    }
}

// DESCARGA DE BUFFER SIN BLOQUEO (SIMULA NAVEGADOR)
async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': ANDROID_UA,
                'Accept': 'video/mp4,video/x-m4v,video/*,audio/mpeg,audio/*',
                'Referer': 'https://yt.savetube.me/', // IMPORTANTE PARA EL VIDEO
                'Connection': 'keep-alive'
            },
            redirect: 'follow'
        });

        if (!res.ok) throw `Status ${res.status}`;
        
        const buffer = await res.buffer();
        
        // Validación de tamaño real para evitar archivos corruptos
        if (buffer.length < 100000 && !url.includes('audio')) { 
            throw 'El video obtenido no es válido (Bloqueo de CDN)';
        }
        
        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] Falló la descarga del archivo final: ${e}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
