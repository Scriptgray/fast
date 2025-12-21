import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import https from 'https'

// --- CONFIGURACIÓN DE AGENTE ---
const jar = new CookieJar()
const client = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false })
}))

const getDynamicHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-ES,es;q=0.9',
})

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', fg: { cyan: '\x1b[36m', red: '\x1b[31m', white: '\x1b[37m' } }
    let prefix = '', colorCode = codes.fg.cyan
    if (text.startsWith('[BUSCANDO]')) prefix = '[BUSCANDO]'
    else if (text.startsWith('[ENVIADO]')) prefix = '[ENVIADO]'
    else if (isError || text.startsWith('[ERROR]')) { prefix = '[ERROR]'; colorCode = codes.fg.red }
    else return `${codes.fg.white}${text}${codes.reset}`
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${text.substring(prefix.length).trim()}`
}

const CONFIG = {
    REQUEST_TIMEOUT: 8000,
    VIDEO_QUALITY: '360', // Calidad rápida
    AUDIO_BITRATE: '128', // Bitrate estándar rápido
    MAX_FILENAME_LENGTH: 50
}

const savetube = {
    api: { base: 'https://media.savetube.me/api', info: '/v2/info', download: '/download', cdn: '/random-cdn' },
    crypto: {
        hexToBuffer: (hex) => Buffer.from(hex.match(/.{1,2}/g).join(''), 'hex'),
        decrypt: async (enc) => {
            const key = savetube.crypto.hexToBuffer('C5D58EF67A7584E4A29F6C35BBC4EB12')
            const data = Buffer.from(enc, 'base64'), iv = data.slice(0, 16), content = data.slice(16)
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
            const dec = Buffer.concat([decipher.update(content), decipher.final()])
            try { return JSON.parse(dec.toString()) } catch { return { title: 'Video', key: null } }
        }
    },
    youtube: (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/)?.[1],
    request: async (path, data = {}, method = 'post') => {
        const url = path.startsWith('http') ? path : `${savetube.api.base}${path}`
        try {
            const res = await client({ method, url, data: method === 'post' ? data : undefined, params: method === 'get' ? data : undefined, headers: getDynamicHeaders(), timeout: CONFIG.REQUEST_TIMEOUT })
            return { status: true, data: res.data }
        } catch {
            try {
                const res = await axios({ method, url, data, timeout: 10000, headers: getDynamicHeaders() })
                return { status: true, data: res.data }
            } catch (e) { return { status: false, error: e.message } }
        }
    },
    download: async (link, type = 'audio') => {
        const id = savetube.youtube(link)
        if (!id) return { status: false }
        const cdnR = await savetube.request(savetube.api.cdn, {}, 'get')
        if (!cdnR.status) return cdnR
        const cdn = cdnR.data.cdn
        const info = await savetube.request(`https://${cdn}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` })
        const dec = await savetube.crypto.decrypt(info.data.data)
        const dl = await savetube.request(`https://${cdn}${savetube.api.download}`, { id, downloadType: type, quality: type === 'audio' ? CONFIG.AUDIO_BITRATE : CONFIG.VIDEO_QUALITY, key: dec.key })
        return { status: true, result: { title: dec.title, download: dl.data.data.downloadUrl } }
    }
}

async function ytdownV2(ytUrl, fmt = 'MP3') {
    const query = `url=${encodeURIComponent(ytUrl)}`
    const info = await client.post('https://ytdown.to/proxy.php', query, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...getDynamicHeaders() } })
    const item = info.data.api.mediaItems.find(it => it.type === (fmt === 'MP3' ? 'Audio' : 'Video'))
    return item ? item.mediaUrl : null
}

async function descargarAudioYT(url) {
    const res = await client.post('https://hub.y2mp3.co/', { url, downloadMode: "audio", audioFormat: "mp3", audioBitrate: CONFIG.AUDIO_BITRATE }, { headers: getDynamicHeaders() })
    return res.data.url || null
}

async function raceWithFallback(url, isAudio, title) {
    const tasks = [
        savetube.download(url, isAudio ? 'audio' : 'video').then(r => r.status ? { download: r.result.download, winner: 'Savetube' } : null).catch(() => null),
        ytdownV2(url, isAudio ? 'MP3' : 'MP4').then(d => d ? { download: d, winner: 'Ytdown' } : null).catch(() => null)
    ]
    if (isAudio) tasks.push(descargarAudioYT(url).then(d => d ? { download: d, winner: 'Ytmp3' } : null).catch(() => null))

    const results = await Promise.all(tasks)
    const winner = results.find(r => r && r.download)
    if (!winner) return null
    return { ...winner, title }
}

async function getBufferFromUrl(url) {
    const res = await fetch(url, { headers: getDynamicHeaders() })
    return res.buffer()
}

function cleanFileName(n) { return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH) }

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
