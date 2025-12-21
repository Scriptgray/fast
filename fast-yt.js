import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"

// AGENTS PARA ROTACIÓN Y EVITAR BLOQUEOS
const AGENTS = [
    'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

const CONFIG = {
    MAX_FILENAME_LENGTH: 50,
    BUFFER_TIMEOUT: 120000 // 2 minutos máximo
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

// LÓGICA DE DESCARGA SAVETUBE (LA MÁS ESTABLE)
const savetube = {
    decrypt: (enc) => {
        const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
        const data = Buffer.from(enc, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secretKey, 'hex'), data.slice(0, 16));
        const decrypted = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
        return JSON.parse(decrypted.toString());
    },
    download: async (url, isAudio) => {
        const id = url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || 
                   url.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3];

        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn');
        const { data: infoRes } = await axios.post(`https://${cdnRes.cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` });
        const info = savetube.decrypt(infoRes.data);

        // CALIDADES ÓPTIMAS: Audio 128 (Ligero) | Video 480 (Seguro)
        const { data: dlRes } = await axios.post(`https://${cdnRes.cdn}/api/download`, {
            id, 
            downloadType: isAudio ? 'audio' : 'video', 
            quality: isAudio ? '128' : '480', 
            key: info.key
        });

        return { download: dlRes.data.downloadUrl, title: info.title };
    }
};

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] Preparando ${isAudio ? 'Audio liviano' : 'Video estable'}`));
    try {
        const res = await savetube.download(url, isAudio);
        return { ...res, winner: 'Savetube' };
    } catch (e) {
        console.error(colorize(`[ERROR] Servicio no disponible temporalmente.`, true));
        return null;
    }
}

// GETBUFFER REPARADO: SISTEMA ANTI-RUNTIME Y ANTI-BLOQUEO
async function getBufferFromUrl(url) {
    let lastError;
    
    // Intenta con 3 identidades diferentes si falla
    for (const agent of AGENTS) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': agent,
                    'Accept': '*/*',
                    'Referer': 'https://yt.savetube.me/',
                    'Connection': 'keep-alive'
                },
                redirect: 'follow',
                timeout: CONFIG.BUFFER_TIMEOUT
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const buffer = await res.buffer();
            
            // Si el buffer es basura (menos de 30KB), forzamos reintento
            if (buffer.length < 30000) throw new Error("Archivo corrupto");
            
            return buffer;
        } catch (e) {
            lastError = e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw lastError;
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
