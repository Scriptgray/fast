import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- AGENT DE ANDROID (FIREFOX MOBILE) ---
const ANDROID_UA = 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/114.0 Firefox/114.0';

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

// --- SERVICIOS OPTIMIZADOS PARA VELOCIDAD ---

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
        
        // Obtenemos CDN de forma ultra rápida
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: savetube.headers });
        const cdn = cdnRes.cdn;

        // Info y Desencriptado
        const { data: infoRes } = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers });
        
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const dec = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        // Para video, bajamos a 360p si 720p falla o es lento. 
        // 360p en Savetube es casi instantáneo.
        const quality = isAudio ? '128' : '360'; 

        const { data: dlRes } = await axios.post(`https://${cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality, key: dec.key
        }, { headers: savetube.headers });

        if (!dlRes.data?.downloadUrl) throw 'Link Error';
        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
}

const ytmp3 = {
    // Este servicio es el más rápido para audio ligero
    download: async (url) => {
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: { 'User-Agent': ANDROID_UA } });
        if (!data.url) throw 'Fail';
        return { download: data.url, winner: 'Ytmp3.gg' };
    }
}

// --- CARRERA DE VELOCIDAD ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio MP3' : 'Video MP4'} rápido...`));

    const tasks = [savetube.download(url, isAudio)];
    if (isAudio) tasks.push(ytmp3.download(url));

    try {
        // Promise.any: El primero que consiga el link gana. Sin esperas.
        const result = await Promise.any(tasks);
        console.log(colorize(`[ENVIADO] ${result.winner} respondió primero.`));
        return { ...result, title: result.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] No se pudo obtener el archivo rápido.`, true));
        return null;
    }
}

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': ANDROID_UA,
                'Range': 'bytes=0-' // Ayuda a que algunos CDNs empiecen a mandar datos más rápido
            },
            redirect: 'follow'
        });
        
        if (!res.ok) throw `Status ${res.status}`;
        
        const buffer = await res.buffer();
        if (buffer.length < 30000) throw 'Archivo corrupto o incompleto';
        
        return buffer;
    } catch (e) {
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
