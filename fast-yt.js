import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"

// --- CONFIGURACIÓN DE AGENTS PARA EVITAR BLOQUEOS ---
const AGENTS = [
    'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36', // Android
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1', // iPhone
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' // Windows
];

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 15000,
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 8000, 
    VIDEO_TIMEOUT: 25000,
    FALLBACK_RACE_TIMEOUT: 40000
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', fg: { custom_cyan: '\x1b[36m', red: '\x1b[31m', white: '\x1b[37m' } }
    let prefix = '', colorCode = codes.fg.custom_cyan
    if (text.startsWith('[BUSCANDO]')) prefix = '[BUSCANDO]'
    else if (text.startsWith('[ENVIADO]')) prefix = '[ENVIADO]'
    else if (isError || text.startsWith('[ERROR]')) { prefix = '[ERROR]'; colorCode = codes.fg.red }
    else return `${codes.fg.white}${text}${codes.reset}`
    const body = text.substring(prefix.length).trim() 
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH)
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// --- SERVICIOS RE-OPTIMIZADOS ---

const savetube = {
    // ... (Mantenemos la lógica de decrypt original que funciona bien)
    crypto: {
        hexToBuffer: (hexString) => Buffer.from(hexString.match(/.{1,2}/g).join(''), 'hex'),
        decrypt: async (enc) => {
            const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
            const data = Buffer.from(enc, 'base64')
            const iv = data.slice(0, 16)
            const content = data.slice(16)
            const key = savetube.crypto.hexToBuffer(secretKey)
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
            const decrypted = Buffer.concat([decipher.update(content), decipher.final()])
            return JSON.parse(decrypted.toString())
        },
    },
    download: async (link, type = 'audio', quality = '360') => {
        const id = link.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || link.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[2] || link.match(/v=([a-zA-Z0-9_-]{11})|be\/([a-zA-Z0-9_-]{11})|shorts\/([a-zA-Z0-9_-]{11})/)?.[3]
        const { data: cdnRes } = await axios.get('https://media.savetube.me/api/random-cdn', { headers: { 'User-Agent': AGENTS[0] } })
        const cdn = cdnRes.cdn
        const { data: infoRes } = await axios.post(`https://${cdn}/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: { 'User-Agent': AGENTS[0] } })
        const dec = await savetube.crypto.decrypt(infoRes.data)
        
        // AUDIO FIJO A 128 PARA PESO BAJO
        const { data: dl } = await axios.post(`https://${cdn}/api/download`, {
            id, downloadType: type, quality: type === 'audio' ? '128' : quality, key: dec.key
        }, { headers: { 'User-Agent': AGENTS[0] } })
        
        return { status: true, result: { download: dl.data.downloadUrl, title: dec.title } }
    }
}

// --- WRAPPERS ---

async function savetube_wrapper(url, isAudio, title) {
    const res = await savetube.download(url, isAudio ? 'audio' : 'video', isAudio ? '128' : '480')
    return { download: res.result.download, title: res.result.title || title, winner: 'Savetube' }
}

async function ytmp3_wrapper(url, title) {
    const { data } = await axios.post('https://hub.y2mp3.co/', {
        url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
    }, { headers: { 'User-Agent': AGENTS[0] } })
    return { download: data.url, title, winner: 'Ytmp3.gg' }
}

// --- CARRERA ---

async function raceWithFallback(url, isAudio, originalTitle) {
    console.log(colorize(`[BUSCANDO] ${isAudio ? 'Audio (Ligero)' : 'Video (MP4)'}`));
    const promises = [savetube_wrapper(url, isAudio, originalTitle).catch(() => null)];
    if (isAudio) promises.push(ytmp3_wrapper(url, originalTitle).catch(() => null));

    const results = await Promise.all(promises);
    const winner = results.find(r => r && r.download);
    
    if (!winner) throw new Error("Fallo en servicios");
    console.log(colorize(`[ENVIADO] Éxito vía ${winner.winner}`));
    return winner;
}

// --- GETBUFFER CON REINTENTOS Y CAMBIO DE AGENT (SOLUCIÓN AL ERROR) ---

async function getBufferFromUrl(url) {
    let lastError;
    
    for (let i = 0; i < AGENTS.length; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': AGENTS[i],
                    'Accept': '*/*',
                    'Connection': 'keep-alive'
                },
                redirect: 'follow',
                timeout: 60000
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const buffer = await res.buffer();
            if (buffer.length < 50000 && !url.includes('audio')) throw new Error("Buffer muy pequeño");
            
            return buffer; // Si llega aquí, tuvo éxito
        } catch (e) {
            lastError = e;
            console.log(colorize(`[ERROR] Reintento de descarga (${i+1}/${AGENTS.length}) con nuevo Agent...`));
            await sleep(1000); // Esperar un segundo antes de cambiar de Agent
        }
    }
    
    throw new Error(`Fallo tras agotar Agents: ${lastError.message}`);
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize };
