import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"

// --- AJUSTES DE VELOCIDAD ---
const TARGET_VIDEO_QUALITY = '360' // Cambiado de 1080 a 360 para rapidez
const AUDIO_BITRATE_DEFAULT = '128' // Estándar para audio completo y rápido

function colorize(text, isError = false) {
    const codes = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        fg: { custom_cyan: '\x1b[36m', red: '\x1b[31m', white: '\x1b[37m' }
    }
    let prefix = ''
    let colorCode = codes.fg.custom_cyan
    if (text.startsWith('[BUSCANDO]')) prefix = '[BUSCANDO]'
    else if (text.startsWith('[ENVIADO]')) prefix = '[ENVIADO]'
    else if (isError || text.startsWith('[ERROR]')) { prefix = '[ERROR]'; colorCode = codes.fg.red }
    else return `${codes.fg.white}${text}${codes.reset}`
    const body = text.substring(prefix.length).trim() 
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`
}

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_DURATION: 18000,
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 6000, // Un poco más de tiempo para evitar errores "No se pudo obtener"
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 5000, // Aumentado para dar oportunidad al primer intento
    VIDEO_TIMEOUT: 8000,
    AUDIO_FALLBACK_TIMEOUT: 10000,
    FALLBACK_RACE_TIMEOUT: 15000
}

const cache = new Map()

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function cleanFileName(n) { return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH) }

const savetube = {
    api: { base: 'https://media.savetube.me/api', info: '/v2/info', download: '/download', cdn: '/random-cdn' },
    headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://yt.savetube.me',
        referer: 'https://yt.savetube.me/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
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
            try { return JSON.parse(decrypted.toString()) } catch { return { title: 'Desconocido', key: null } }
        },
    },
    isUrl: (str) => { try { new URL(str); return /youtube.com|youtu.be/.test(str) } catch { return false } },
    youtube: (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/)?.[1],
    request: async (endpoint, data = {}, method = 'post') => {
        try {
            const { data: res } = await axios({
                method,
                url: `${endpoint.startsWith('http') ? '' : savetube.api.base}${endpoint}`,
                data: method === 'post' ? data : undefined,
                params: method === 'get' ? data : undefined,
                headers: savetube.headers,
                timeout: CONFIG.REQUEST_TIMEOUT,
            })
            return { status: true, data: res }
        } catch (err) { return { status: false, error: err.message } }
    },
    getCDN: async () => {
        const r = await savetube.request(savetube.api.cdn, {}, 'get')
        return r.status ? { status: true, data: r.data.cdn } : r
    },
    download: async (link, type = 'audio', quality = TARGET_VIDEO_QUALITY) => { 
        const id = savetube.youtube(link)
        if (!id) return { status: false }
        try {
            const cdnx = await savetube.getCDN()
            const cdn = cdnx.data
            const info = await savetube.request(`https://${cdn}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` })
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            const downloadData = await savetube.request(`https://${cdn}${savetube.api.download}`, {
                id,
                downloadType: type === 'audio' ? 'audio' : 'video',
                quality: type === 'audio' ? AUDIO_BITRATE_DEFAULT : quality,
                key: decrypted.key,
            })
            return { status: true, result: { title: decrypted.title, download: downloadData.data?.data?.downloadUrl } }
        } catch (err) { return { status: false, error: err.message } }
    },
}

// --- OTROS SERVIDORES (YTDOWN, Y2DOWN, YTMP3GG) ---
// (Se mantienen las lógicas de los wrappers que ya tenías pero usando las constantes de calidad)

async function savetube_wrapper(url, isAudio, title) {
    const result = await savetube.download(url, isAudio ? 'audio' : 'video', TARGET_VIDEO_QUALITY)
    if (!result?.status || !result?.result?.download) throw new Error("Savetube failed")
    return { download: result.result.download, title, winner: 'Savetube' }
}

async function ytdown_gg_wrapper(url, originalTitle) {
    // Forzamos 128kbps para audio completo
    const response = await axios.post('https://hub.y2mp3.co/', {
        url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: AUDIO_BITRATE_DEFAULT
    })
    if (!response.data.url) throw new Error("Ytmp3.gg failed")
    return { download: response.data.url, title: originalTitle, winner: 'Ytmp3.gg' }
}

async function raceWithFallback(url, isAudio, originalTitle) {
    const promises = [
        savetube_wrapper(url, isAudio, originalTitle).catch(() => null),
        ytdown_gg_wrapper(url, originalTitle).catch(() => null)
    ]
    
    // Aquí podrías agregar los otros wrappers si los necesitas, 
    // pero estos dos son los más rápidos para 360p y 128kbps.

    const results = await Promise.all(promises)
    const winner = results.find(r => r && r.download)
    
    if (!winner) {
        console.error(colorize(`[ERROR] No se pudo obtener el archivo.`, true))
        return null
    }
    return winner
}

async function getBufferFromUrl(url) {
    const res = await fetch(url)
    return res.buffer()
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
