import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"

// --- CONFIGURACIÓN Y UTILIDADES ---

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_DURATION: 18000,
    MAX_RETRIES: 4,
    REQUEST_TIMEOUT: 4500,
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 85,
    VIDEO_TIMEOUT: 6000,
    AUDIO_FALLBACK_TIMEOUT: 550,
    FALLBACK_RACE_TIMEOUT: 8000
}

const cache = new Map()

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
    else if (isError || text.startsWith('[ERROR]')) {
        prefix = '[ERROR]'
        colorCode = codes.fg.red
    } else return `${codes.fg.white}${text}${codes.reset}`
    
    const body = text.substring(prefix.length).trim() 
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH)
}

// --- SERVICIOS DE DESCARGA (SAVETUBE, YTDown, etc.) ---

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
            const data = Buffer.from(enc, 'base64'), iv = data.slice(0, 16), content = data.slice(16)
            const key = savetube.crypto.hexToBuffer(secretKey)
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
            const decrypted = Buffer.concat([decipher.update(content), decipher.final()])
            try { return JSON.parse(decrypted.toString()) } catch { return { title: 'Desconocido', duration: '??', key: null } }
        },
    },
    isUrl: (str) => {
        try { return /youtube.com|youtu.be/.test(str) } catch { return false }
    },
    youtube: (url) => {
        const patterns = [/v=([a-zA-Z0-9_-]{11})/, /embed\/([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /shorts\/([a-zA-Z0-9_-]{11})/, /live\/([a-zA-Z0-9_-]{11})/]
        for (let p of patterns) { if (p.test(url)) return url.match(p)[1] }
        return null
    },
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
        const cacheKey = 'savetube_cdn', cached = cache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < 300000) return { status: true, data: cached.data }
        const r = await savetube.request(savetube.api.cdn, {}, 'get')
        if (!r.status) return r
        cache.set(cacheKey, { data: r.data.cdn, timestamp: Date.now() })
        return { status: true, data: r.data.cdn }
    },
    download: async (link, type = 'audio', quality = '360') => { 
        const id = savetube.youtube(link)
        if (!id) return { status: false, error: 'No se pudo obtener ID del video' }
        try {
            const cdnx = await savetube.getCDN()
            if (!cdnx.status) throw new Error('No se pudo obtener CDN')
            const info = await savetube.request(`https://${cdnx.data}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` })
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            const downloadData = await savetube.request(`https://${cdnx.data}${savetube.api.download}`, {
                id, downloadType: type === 'audio' ? 'audio' : 'video', quality: type === 'audio' ? '128' : quality, key: decrypted.key,
            })
            return { status: true, result: { title: decrypted.title || 'Desconocido', download: downloadData.data?.data?.downloadUrl, duration: decrypted.duration || '??' } }
        } catch (err) { return { status: false, error: err.message } }
    },
}

async function processDownloadWithRetry_savetube(isAudio, url, retryCount = 0, videoQuality = '360') {
    const type = isAudio ? 'audio' : 'video'
    let result = await savetube.download(url, type, videoQuality) 
    if (!result.status && retryCount < CONFIG.MAX_RETRIES) {
        await sleep(1500)
        return processDownloadWithRetry_savetube(isAudio, url, retryCount + 1, videoQuality) 
    }
    return result
}

class YTDown {
    constructor() {
        this.ref = 'https://ytdown.to/es2/'; this.origin = 'https://ytdown.to'
        this.staticUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    async req(url, dat) {
        const res = await axios({ method: 'POST', url, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Origin': this.origin, 'Referer': this.ref, 'User-Agent': this.staticUA }, data: dat, timeout: 30000 })
        return res.data
    }
    async ytdownV2(ytUrl, fmt = 'MP3', quality = '360') {
        const info = await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(ytUrl)}`)
        const itm = info.api.mediaItems.find(i => (fmt === 'MP3' ? i.type === 'Audio' : i.mediaRes?.includes(quality))) || info.api.mediaItems[0]
        const dl = await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(itm.mediaUrl)}`)
        return dl.api.fileUrl || itm.mediaUrl
    }
}

const ytdownV2 = async (ytUrl, fmt = 'MP3', quality = '360') => {
    const yt = new YTDown(); return await yt.ytdownV2(ytUrl, fmt, quality)
}

async function yt2dow_cc(videoUrl, options = {}) {
    const { quality = '360', format = 'mp3', type = 'video' } = options 
    const apiKey = 'dfcb6d76f2f6a9894gjkege8a4ab232222'
    const res = await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${type === 'video' ? quality : format}&url=${encodeURIComponent(videoUrl)}&api=${apiKey}`)
    const data = await res.json()
    return `https://p.savenow.to/api/progress?id=${data.id}` // Simplificado para la carrera
}

async function descargarAudioYouTube(urlVideo) {
    const response = await axios.post('https://hub.y2mp3.co/', { url: urlVideo, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128" })
    return { success: true, downloadUrl: response.data.url }
}

// --- WRAPPERS ---

const TARGET_VIDEO_QUALITY = '360' 

async function savetube_wrapper(url, isAudio, originalTitle) {
    const result = await processDownloadWithRetry_savetube(isAudio, url, 0, TARGET_VIDEO_QUALITY)
    if (!result?.status || !result?.result?.download) throw new Error("Savetube Fail")
    return { download: result.result.download, title: result.result.title || originalTitle, winner: 'Savetube' }
}

async function ytdownV2_wrapper(url, isAudio, originalTitle) {
    const downloadUrl = await ytdownV2(url, isAudio ? 'MP3' : 'MP4', TARGET_VIDEO_QUALITY)
    return { download: downloadUrl, title: originalTitle, winner: 'Ytdown.to' }
}

async function yt2dow_cc_wrapper(url, isAudio, originalTitle) {
    const downloadUrl = await yt2dow_cc(url, isAudio ? { type: 'audio', format: 'mp3' } : { type: 'video', quality: TARGET_VIDEO_QUALITY })
    return { download: downloadUrl, title: originalTitle, winner: 'Yt2dow.cc' }
}

async function ytdown_gg_wrapper(url, originalTitle) {
    const result = await descargarAudioYouTube(url)
    return { download: result.downloadUrl, title: originalTitle, winner: 'Ytmp3.gg' }
}

function timeoutPromise(promise, ms, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`TIMEOUT: ${name}`)), ms)
        promise.then(v => { clearTimeout(timer); resolve(v); }, r => { clearTimeout(timer); reject(r); })
    })
}

// --- FUNCIÓN PRINCIPAL SOLICITADA ---

async function raceWithFallback(url, isAudio, originalTitle, conn, jid) {
    const raceTimeout = isAudio ? CONFIG.FAST_TIMEOUT : CONFIG.VIDEO_TIMEOUT
    const fallbackTimeout = isAudio ? CONFIG.AUDIO_FALLBACK_TIMEOUT : CONFIG.FALLBACK_RACE_TIMEOUT

    const executeRace = async (ms, name_suffix = '') => {
        const promises = [
            timeoutPromise(savetube_wrapper(url, isAudio, originalTitle), ms, `Savetube${name_suffix}`).catch(e => ({ error: e.message })),
            timeoutPromise(ytdownV2_wrapper(url, isAudio, originalTitle), ms, `Ytdown.to${name_suffix}`).catch(e => ({ error: e.message })),
            timeoutPromise(yt2dow_cc_wrapper(url, isAudio, originalTitle), ms, `Yt2dow.cc${name_suffix}`).catch(e => ({ error: e.message })),
        ]
        if (isAudio) promises.push(timeoutPromise(ytdown_gg_wrapper(url, originalTitle), ms, `Ytmp3.gg${name_suffix}`).catch(e => ({ error: e.message })))

        const winner = await Promise.race(promises)
        if (winner && winner.download) return winner
        
        const results = await Promise.all(promises)
        return results.find(r => r && r.download)
    }

    let mediaResult = await executeRace(raceTimeout)
    if (!mediaResult?.download) mediaResult = await executeRace(fallbackTimeout)
    if (!mediaResult?.download) mediaResult = await executeRace(CONFIG.FALLBACK_RACE_TIMEOUT)

    if (mediaResult?.download) {
        mediaResult.credit = "By Corvette para Shiroko";
        
        // Enviar el mensaje solicitado vía WhatsApp
        if (conn && jid) {
            await conn.sendMessage(jid, { text: "By Corvette para Shiroko" })
        }
        
        return mediaResult
    }

    console.error(colorize(`[ERROR] No se pudo obtener el archivo.`, true))
    return null
}

async function getBufferFromUrl(url) {
    const res = await fetch(url)
    return res.buffer()
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
