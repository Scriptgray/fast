import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"
import { PassThrough } from "stream"

// AGENT ULTRA-REALISTA DE ANDROID
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 300000, // 5 Minutos (Máxima paciencia)
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
    download: async (url, isAudio) => {
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
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '360', key: dec.key
        }, { headers });

        return { download: dlRes.data.downloadUrl, winner: 'Savetube', title: dec.title };
    }
};

const y2mate = {
    // Servicio de respaldo ultra-estable
    download: async (url, isAudio) => {
        const { data } = await axios.post('https://www.y2mate.com/api/ajaxSearch/index', `url=${encodeURIComponent(url)}&q_auto=0&ajax=1`, {
            headers: { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });
        const vidId = data.vid;
        const key = isAudio ? Object.values(data.links.mp3).find(v => v.q === '128kbps')?.k : Object.values(data.links.mp4).find(v => v.q === '360p')?.k;
        
        const { data: dlRes } = await axios.post('https://www.y2mate.com/api/ajaxSearch/convert', `type=youtube&_id=${vidId}&v_id=${vidId}&ajax=1&token=&ftype=${isAudio ? 'mp3' : 'mp4'}&fquality=${isAudio ? '128' : '360'}&k=${encodeURIComponent(key)}`, {
            headers: { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });
        
        return { download: dlRes.dlink, winner: 'Y2Mate' };
    }
};

// --- FUNCIÓN DE CARRERA ---
async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] Intentando descarga segura...`));
    
    // Lista de servicios en orden de estabilidad
    const servicesList = [
        () => savetube.download(url, isAudio),
        () => y2mate.download(url, isAudio)
    ];

    for (let service of servicesList) {
        try {
            const res = await service();
            if (res && res.download && res.download.startsWith('http')) {
                console.log(colorize(`[ENVIADO] Éxito vía ${res.winner}`));
                return { ...res, title: res.title || originalTitle };
            }
        } catch (e) { continue; }
    }
    return null;
}

// --- DESCARGA DE BUFFER CON CABECERAS DE NAVEGACIÓN ---
async function getBufferFromUrl(url) {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': ANDROID_UA,
                'Referer': 'https://www.youtube.com/',
                'Accept': '*/*',
                'Range': 'bytes=0-',
                'Connection': 'keep-alive'
            },
            timeout: CONFIG.BUFFER_TIMEOUT,
            maxRedirects: 10
        });

        const buffer = Buffer.from(response.data);
        
        if (buffer.length < 50000) { // Menos de 50KB es un error seguro
            throw new Error('Archivo demasiado pequeño o bloqueado');
        }

        return buffer;
    } catch (e) {
        console.error(colorize(`[ERROR] Descarga fallida: ${e.message}`, true));
        throw e;
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
