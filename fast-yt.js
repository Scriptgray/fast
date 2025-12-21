import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// --- CONFIGURACIÓN DE NAVEGACIÓN (ANDROID SIMULATION) ---
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36';

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    // Tiempos ultra-rápidos para respuesta inmediata
    RACE_TIMEOUT: 15000, 
    BUFFER_TIMEOUT: 30000
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

// --- SERVICIOS OPTIMIZADOS ---

const services = {
    savetube: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];
        if (!id) throw 'No ID';
        const headers = { 'user-agent': ANDROID_UA, 'content-type': 'application/json' };
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers });
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers });
        
        // Desencriptación rápida
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const encData = Buffer.from(infoRes.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), encData.slice(0, 16));
        const decrypted = JSON.parse(Buffer.concat([decipher.update(encData.slice(16)), decipher.final()]).toString());

        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, downloadType: isAudio ? 'audio' : 'video', quality: isAudio ? '128' : '720', key: decrypted.key
        }, { headers });
        
        return { download: dlRes.data.downloadUrl, winner: 'Savetube' };
    },

    ytdown: async (url, isAudio) => {
        const { data: info } = await axios.post('https://ytdown.to/proxy.php', `url=${encodeURIComponent(url)}`, { 
            headers: { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/x-www-form-urlencoded' } 
        });
        const items = info.api?.mediaItems || [];
        const target = items.find(it => (isAudio ? it.type === 'Audio' : it.mediaRes?.includes('720'))) || items[0];
        if (!target?.mediaUrl) throw 'No Link';
        return { download: target.mediaUrl, winner: 'Ytdown.to' };
    },

    ytmp3: async (url, isAudio) => {
        if (!isAudio) throw 'Solo audio';
        const { data } = await axios.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: { 'User-Agent': ANDROID_UA } });
        if (!data.url) throw 'Fail';
        return { download: data.url, winner: 'Ytmp3.gg' };
    }
};

// --- FUNCIÓN PRINCIPAL (LA CARRERA) ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio' : 'Video'} → ${originalTitle}`));

    // Creamos todas las promesas al mismo tiempo
    const promises = [
        services.savetube(url, isAudio),
        services.ytdown(url, isAudio)
    ];
    if (isAudio) promises.push(services.ytmp3(url, isAudio));

    try {
        // Promise.any devuelve el PRIMERO que resuelva con éxito. 
        // Es la forma más rápida posible de obtener el resultado.
        const result = await Promise.any(promises);
        
        console.log(colorize(`[ENVIADO] ${result.winner} ganó la carrera.`));
        return {
            ...result,
            title: originalTitle
        };
    } catch (e) {
        console.error(colorize(`[ERROR] Todos los servicios fallaron o fueron lentos.`, true));
        return null;
    }
}

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: { 'User-Agent': ANDROID_UA },
            timeout: CONFIG.BUFFER_TIMEOUT 
        });
        if (!res.ok) throw '';
        return await res.buffer();
    } catch (e) {
        throw new Error("No se pudo descargar el archivo final.");
    }
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
