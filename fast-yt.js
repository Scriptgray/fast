import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import https from 'https'

// --- CONFIGURACIÓN DE AGENTE Y ANTI-COOKIES ---
const jar = new CookieJar()
const client = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    httpsAgent: new https.Agent({ 
        keepAlive: true, 
        rejectUnauthorized: false 
    })
}))

const getDynamicHeaders = () => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    ]
    return {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    }
}

function colorize(text, isError = false) {
    const codes = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        fg: {
            custom_cyan: '\x1b[36m', 
            red: '\x1b[31m', 
            white: '\x1b[37m',
        }
    }

    let prefix = ''
    let colorCode = codes.fg.custom_cyan

    if (text.startsWith('[BUSCANDO]')) {
        prefix = '[BUSCANDO]'
    } else if (text.startsWith('[ENVIADO]')) {
        prefix = '[ENVIADO]'
    } else if (isError || text.startsWith('[ERROR]')) {
        prefix = '[ERROR]'
        colorCode = codes.fg.red
    } else {
        return `${codes.fg.white}${text}${codes.reset}`
    }

    const body = text.substring(prefix.length).trim() 
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`
}

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_DURATION: 18000,
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 10000, // Aumentado para evitar fallos por lentitud del server
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 10000,
    VIDEO_TIMEOUT: 15000,
    AUDIO_FALLBACK_TIMEOUT: 15000,
    FALLBACK_RACE_TIMEOUT: 20000
}

const cache = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CONFIG.CACHE_DURATION) {
            cache.delete(key)
        }
    }
}, 3600000)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH)
}

const savetube = {
    api: {
        base: 'https://media.savetube.me/api',
        info: '/v2/info',
        download: '/download',
        cdn: '/random-cdn',
    },
    headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://yt.savetube.me',
        referer: 'https://yt.savetube.me/',
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
            try {
                return JSON.parse(decrypted.toString())
            } catch {
                return { title: 'Desconocido', duration: '??', key: null }
            }
        },
    },
    isUrl: (str) => {
        try {
            new URL(str)
            return /youtube.com|youtu.be/.test(str)
        } catch {
            return false
        }
    },
    youtube: (url) => {
        const patterns = [
            /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
            /youtu\.be\/([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
        ]
        for (let p of patterns) {
            if (p.test(url)) return url.match(p)[1]
        }
        return null
    },
    request: async (endpoint, data = {}, method = 'post') => {
        const url = endpoint.startsWith('http') ? endpoint : `${savetube.api.base}${endpoint}`
        const headers = { ...savetube.headers, ...getDynamicHeaders() }
        try {
            const res = await client({
                method,
                url,
                data: method === 'post' ? data : undefined,
                params: method === 'get' ? data : undefined,
                headers,
                timeout: CONFIG.REQUEST_TIMEOUT,
            })
            return { status: true, data: res.data }
        } catch (err) {
            // Respaldar con axios normal si el cliente con cookies falla
            try {
                const res = await axios({ method, url, data, headers: getDynamicHeaders(), timeout: 15000 })
                return { status: true, data: res.data }
            } catch (e) {
                return { status: false, error: err.message }
            }
        }
    },
    getCDN: async () => {
        const cacheKey = 'savetube_cdn'
        const cached = cache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < 300000) return { status: true, data: cached.data }
        
        const r = await savetube.request(savetube.api.cdn, {}, 'get')
        if (!r.status) return r
        cache.set(cacheKey, { data: r.data.cdn, timestamp: Date.now() })
        return { status: true, data: r.data.cdn }
    },
    download: async (link, type = 'audio', quality = '360') => { 
        if (!savetube.isUrl(link)) return { status: false, error: 'URL inválida' }
        const id = savetube.youtube(link)
        if (!id) return { status: false, error: 'ID no hallado' }
        
        try {
            const cdnx = await savetube.getCDN()
            if (!cdnx.status) throw new Error('CDN falló')
            const cdn = cdnx.data
            
            const info = await savetube.request(`https://${cdn}${savetube.api.info}`, {
                url: `https://www.youtube.com/watch?v=${id}`,
            })
            if (!info.status || !info.data?.data) throw new Error('Info falló')
            
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            if (!decrypted.key) throw new Error('Clave falló')
            
            const downloadData = await savetube.request(`https://${cdn}${savetube.api.download}`, {
                id,
                downloadType: type === 'audio' ? 'audio' : 'video',
                quality: type === 'audio' ? '128' : quality,
                key: decrypted.key,
            })
            
            const url = downloadData.data?.data?.downloadUrl
            if (!url) throw new Error('URL no generada')
            
            return {
                status: true,
                result: { title: decrypted.title || 'Desconocido', download: url, duration: decrypted.duration || '??' },
            }
        } catch (err) {
            return { status: false, error: err.message }
        }
    },
}

async function processDownloadWithRetry_savetube(isAudio, url, retryCount = 0, videoQuality = '720') {
    const type = isAudio ? 'audio' : 'video'
    let result = await savetube.download(url, type, videoQuality) 
    if (!result.status && !isAudio && videoQuality !== '240') result = await savetube.download(url, type, '240')
    if (!result.status && retryCount < CONFIG.MAX_RETRIES) {
        await sleep(1500)
        return processDownloadWithRetry_savetube(isAudio, url, retryCount + 1, videoQuality) 
    }
    return result
}

class YTDown {
    constructor() {
        this.ref = 'https://ytdown.to/es2/'
        this.ct = 'application/x-www-form-urlencoded; charset=UTF-8'
        this.origin = 'https://ytdown.to'
    }

    async req(url, dat, acc = '*/*') {
        try {
            const res = await client({
                method: 'POST',
                url,
                headers: { 'Accept': acc, 'Content-Type': this.ct, 'Origin': this.origin, 'Referer': this.ref, ...getDynamicHeaders() },
                data: dat,
                timeout: 20000
            })
            return res.data
        } catch (err) { throw new Error(err.message) }
    }

    async chk() { 
        const res = await this.req('https://ytdown.to/cooldown.php', 'action=check', 'application/json')
        return res.can_download === true 
    }

    async getInfo(url) { return await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(url)}`) }

    async rec() { 
        const res = await this.req('https://ytdown.to/cooldown.php', 'action=record', 'application/json')
        return res.success === true 
    }

    async startDL(dlUrl) { return await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(dlUrl)}`) }

    async waitForDL(dlUrl, timeout = 30000) {
        const start = Date.now()
        while (Date.now() - start < timeout) {
            const res = await this.startDL(dlUrl)
            if (res.api && res.api.fileUrl) return res.api.fileUrl
            await sleep(2000)
        }
        return dlUrl
    }

    async ytdownV2(ytUrl, fmt = 'MP3', quality = '360') {
        if (!(await this.chk())) throw new Error("Servicio ocupado")
        const info = await this.getInfo(ytUrl)
        if (info.api?.status === 'ERROR') throw new Error(info.api.message)
        
        const type = fmt.toUpperCase() === 'MP3' ? 'Audio' : 'Video'
        const med = info.api.mediaItems.find(it => it.type === type)
        if (!med) throw new Error("No media")
        
        await this.rec()
        return await this.waitForDL(med.mediaUrl)
    }
}

const ytdownV2 = async (ytUrl, fmt = 'MP3', quality = '360') => {
    const yt = new YTDown()
    return await yt.ytdownV2(ytUrl, fmt, quality)
}

async function processDownload_y2down(videoUrl, mediaType, quality = null) {
    const apiKey = 'dfcb6d76f2f6a9894gjkege8a4ab232222'
    const format = audioQualities.includes(mediaType) ? mediaType : quality
    const initUrl = `https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(videoUrl)}&api=${apiKey}`
    
    try {
        const res = await fetch(initUrl, { headers: getDynamicHeaders() })
        const data = await res.json()
        if (!data.success) throw new Error('Init failed')

        for (let i = 0; i < 15; i++) {
            await sleep(3000)
            const prog = await fetch(`https://p.savenow.to/api/progress?id=${data.id}`, { headers: getDynamicHeaders() })
            const pData = await prog.json()
            if (pData.progress === 1000 && pData.download_url) return pData.download_url
        }
        throw new Error('Timeout y2down')
    } catch (e) { throw e }
}

const audioQualities = ['mp3', 'm4a', 'webm', 'aacc', 'flac', 'apus', 'ogg', 'wav']

async function descargarAudioYouTube(urlVideo) {
    try {
        const res = await client.post('https://hub.y2mp3.co/', {
            url: urlVideo, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { headers: getDynamicHeaders() })
        if (!res.data.url) throw new Error("No URL")
        return { success: true, downloadUrl: res.data.url }
    } catch (e) { throw e }
}

// Wrappers y Race logic
async function savetube_wrapper(url, isAudio, title) {
    const res = await processDownloadWithRetry_savetube(isAudio, url, 0, '1080')
    return { download: res.result.download, title, winner: 'Savetube' }
}

async function ytdownV2_wrapper(url, isAudio, title) {
    const d = await ytdownV2(url, isAudio ? 'MP3' : 'MP4', '1080')
    return { download: d, title, winner: 'Ytdown.to' }
}

async function yt2dow_cc_wrapper(url, isAudio, title) {
    const d = await processDownload_y2down(url, isAudio ? 'mp3' : 'video', '1080')
    return { download: d, title, winner: 'Yt2dow.cc' }
}

async function ytdown_gg_wrapper(url, title) {
    const res = await descargarAudioYouTube(url)
    return { download: res.downloadUrl, title, winner: 'Ytmp3.gg' }
}

function timeoutPromise(promise, ms, name) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`TIMEOUT: ${name}`)), ms)
        promise.then(v => { clearTimeout(t); resolve(v) }).catch(e => { clearTimeout(t); reject(e) })
    })
}

async function raceWithFallback(url, isAudio, originalTitle) {
    const promises = [
        savetube_wrapper(url, isAudio, originalTitle).catch(() => null),
        ytdownV2_wrapper(url, isAudio, originalTitle).catch(() => null),
        yt2dow_cc_wrapper(url, isAudio, originalTitle).catch(() => null)
    ]
    if (isAudio) promises.push(ytdown_gg_wrapper(url, originalTitle).catch(() => null))

    const results = await Promise.all(promises)
    const winner = results.find(r => r && r.download)
    
    if (!winner) {
        console.error(colorize(`[ERROR] No se pudo obtener el archivo.`, true))
        return null
    }
    return winner
}

async function getBufferFromUrl(url) {
    const res = await fetch(url, { headers: getDynamicHeaders() })
    if (!res.ok) throw new Error(`Error: ${res.statusText}`)
    return res.buffer()
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
