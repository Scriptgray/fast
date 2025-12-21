import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// AGENTS LIGEROS PARA MÁXIMA COMPATIBILIDAD
const AGENTS = [
    'Mozilla/5.0 (Linux; Android 10; SM-A205U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.163 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
];

const CONFIG = {
    MAX_FILENAME_LENGTH: 40,
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

const services = {
    // MÉTODO AUDIO RÁPIDO (YTMP3 MODIFICADO)
    fastAudio: async (url) => {
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { timeout: 10000 });
        return { download: data.url, winner: 'Ytmp3' };
    },

    // MÉTODO VIDEO ESTABLE (SAVETUBE 360p - MÁXIMA VELOCIDAD)
    stableVideo: async (url) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn');
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` });
        
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const data = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), data.slice(0, 16));
        const info = JSON.parse(Buffer.concat([decipher.update(data.slice(16)), decipher.final()]).toString());

        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, downloadType: 'video', quality: '360', key: info.key
        });
        return { download: dlRes.data.downloadUrl, title: info.title, winner: 'Savetube' };
    }
};

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] Optimizando recursos para ${isAudio ? 'Audio' : 'Video'}`));
    try {
        const res = isAudio ? await services.fastAudio(url) : await services.stableVideo(url);
        return { ...res, title: res.title || originalTitle };
    } catch (e) {
        console.error(colorize(`[ERROR] Error en la solicitud: ${e.message}`, true));
        return null;
    }
}

// GETBUFFER CON LIMITACIÓN DE FLUJO (EVITA EL RUNTIME)
async function getBufferFromUrl(url) {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'arraybuffer', // Usamos arraybuffer de axios que es más eficiente en memoria que fetch.buffer()
            headers: {
                'User-Agent': AGENTS[0],
                'Referer': 'https://yt.savetube.me/'
            },
            timeout: CONFIG.BUFFER_TIMEOUT,
            maxContentLength: 100 * 1024 * 1024, // Límite de 100MB para evitar que el bot explote
        });

        if (response.data.length < 20000) throw new Error("Archivo corrupto/vacío");
        
        return Buffer.from(response.data);
    } catch (e) {
        console.error(colorize(`[ERROR] No se pudo descargar el buffer: ${e.message}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
