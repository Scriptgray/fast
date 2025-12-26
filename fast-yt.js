import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"
import cheerio from "cheerio"
import ytdl from "ytdl-core"
import { promises as fs } from 'fs'
import path from 'path'

const git = [
    'git+https://github.com/Arlette-Xz/Shiroko-Bot.git',
    'git+https://github.com/Dylan/Nezuko-Bot.git'
];

async function verificarRepo() {
    try {
        const jsonPath = path.join(process.cwd(), 'package.json');
        const contenido = await fs.readFile(jsonPath, 'utf-8');
        const packageJson = JSON.parse(contenido);
        const repoUrl = packageJson.repository?.url;
        return git.includes(repoUrl);
    } catch {
        return false;
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
    MAX_RETRIES: 2, // Reducido para saltar más rápido entre opciones
    REQUEST_TIMEOUT: 3500, // Timeout más agresivo para mayor velocidad
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 12, // Segundos para la primera oleada
    VIDEO_TIMEOUT: 5000, 
    AUDIO_FALLBACK_TIMEOUT: 60,
    FALLBACK_RACE_TIMEOUT: 7000
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

function formatViews(v) {
    if (!v) return "No disponible"
    const num = typeof v === 'string' ? parseInt(v.replace(/,/g, ''), 10) : v
    if (isNaN(num)) return "No disponible"
    if (num >= 1e9) return (num / 1e9).toFixed(1) + "B"
    if (num >= 1e6) return (num / 1e6).toFixed(1) + "M"
    if (num >= 1e3) return (num / 1e3).toFixed(1) + "K"
    return num.toString()
}

// --- BÚSQUEDA AVANZADA OPTIMIZADA ---
async function ytSearch(query) {
    try {
        const { data } = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' }
        })
        const $ = cheerio.load(data)
        let _string = ""
        $("script").each((i, e) => {
            if (/var ytInitialData = /gi.exec($(e).html())) {
                _string += $(e).html().replace(/var ytInitialData = /i, "").replace(/;$/, "")
            }
        })
        const json = JSON.parse(_string)
        const contents = json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
        return contents.map(item => {
            const v = item.videoRenderer
            if (!v) return null
            return {
                title: v.title.runs[0].text,
                duration: v.lengthText?.simpleText || "00:00",
                thumbnail: v.thumbnail.thumbnails[v.thumbnail.thumbnails.length - 1].url,
                uploaded: v.publishedTimeText?.simpleText || "Desconocido",
                views: v.viewCountText?.simpleText || "0",
                url: "https://www.youtube.com/watch?v=" + v.videoId
            }
        }).filter(Boolean)
    } catch (e) {
        return { error: true, message: String(e) }
    }
}

const savetube = {
    api: { base: 'https://media.savetube.me/api', info: '/v2/info', download: '/download', cdn: '/random-cdn' },
    headers: {
        accept: '*/*', 'content-type': 'application/json', origin: 'https://yt.savetube.me', referer: 'https://yt.savetube.me/',
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
    request: async (endpoint, data = {}, method = 'post') => {
        try {
            const { data: res } = await axios({
                method, url: `${endpoint.startsWith('http') ? '' : savetube.api.base}${endpoint}`,
                data: method === 'post' ? data : undefined, params: method === 'get' ? data : undefined,
                headers: savetube.headers, timeout: CONFIG.REQUEST_TIMEOUT,
            })
            return { status: true, data: res }
        } catch (err) { return { status: false, error: err.message } }
    },
    download: async (link, type = 'audio', quality = '360') => {
        const id = link.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)?.[1]
        try {
            const info = await savetube.request(`https://cdn1.savetube.me${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` })
            if (!info.status || !info.data?.data) throw new Error('Info failed')
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            const downloadData = await savetube.request(`https://cdn1.savetube.me${savetube.api.download}`, {
                id, downloadType: type, quality: type === 'audio' ? '128' : quality, key: decrypted.key,
            })
            return { status: true, result: { title: decrypted.title, download: downloadData.data?.data?.downloadUrl } }
        } catch (err) { return { status: false, error: err.message } }
    },
}

async function ytmp4_socdown(url) {
    try {
        const response = await axios.post('https://socdown.com/wp-json/aio-dl/video-data/', { url }, {
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 4000
        });
        return response.data.medias.find(m => m.extension === 'mp4')?.url;
    } catch { return null }
}

async function descargarAudioYouTube(urlVideo) {
    try {
        const response = await axios.post('https://hub.y2mp3.co/', {
            url: urlVideo, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128"
        }, { timeout: 4000 })
        return { success: true, downloadUrl: response.data.url }
    } catch { return { success: false } }
}

async function ytmp3_direct(url) {
    try {
        const info = await ytdl.getInfo(url);
        const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return { buffer: Buffer.concat(chunks), title: info.videoDetails.title };
    } catch { return null }
}

const TARGET_VIDEO_QUALITY = '360' 

async function savetube_wrapper(url, isAudio, originalTitle) {
    const result = await savetube.download(url, isAudio ? 'audio' : 'video', TARGET_VIDEO_QUALITY)
    if (!result?.status || !result?.result?.download) throw new Error('Savetube fail')
    return { download: result.result.download, title: originalTitle, winner: 'Savetube' }
}

async function ytdownV2_wrapper(url, isAudio, originalTitle) {
    const yt = new YTDown();
    const downloadUrl = await yt.ytdownV2(url, isAudio ? 'MP3' : 'MP4', TARGET_VIDEO_QUALITY);
    return { download: downloadUrl, title: originalTitle, winner: 'Ytdown.to' }
}

async function yt2dow_cc_wrapper(url, isAudio, originalTitle) {
    const downloadUrl = await yt2dow_cc(url, isAudio ? { type: 'audio', format: 'mp3' } : { type: 'video', quality: TARGET_VIDEO_QUALITY });
    return { download: downloadUrl, title: originalTitle, winner: 'Yt2dow.cc' }
}

function timeoutPromise(promise, ms, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`TIMEOUT: ${name}`)), ms)
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); })
    })
}

async function raceWithFallback(url, isAudio, originalTitle) {
    if (!(await verificarRepo())) return null;
    const ms = isAudio ? CONFIG.FAST_TIMEOUT * 1000 : CONFIG.VIDEO_TIMEOUT;

    const executeRace = async () => {
        const promises = [
            timeoutPromise(savetube_wrapper(url, isAudio, originalTitle), ms, 'Savetube').catch(() => null),
            timeoutPromise(ytdownV2_wrapper(url, isAudio, originalTitle), ms, 'Ytdown').catch(() => null),
            timeoutPromise(yt2dow_cc_wrapper(url, isAudio, originalTitle), ms, 'Yt2dow').catch(() => null),
        ]
        if (isAudio) {
            promises.push(descargarAudioYouTube(url).then(r => r.success ? { download: r.downloadUrl, winner: 'Ytmp3.gg' } : null).catch(() => null))
        } else {
            promises.push(ytmp4_socdown(url).then(dl => dl ? { download: dl, winner: 'Socdown' } : null).catch(() => null))
        }
        
        // Usamos Promise.any para obtener el primero que resuelva correctamente (el más rápido)
        try {
            return await Promise.any(promises.filter(p => p !== null).map(p => p.then(res => res || Promise.reject())))
        } catch { return null }
    }

    console.log(colorize(`[BUSCANDO] Ejecutando carrera de descarga...`));
    let mediaResult = await executeRace();

    if (!mediaResult) {
        console.log(colorize(`[ERROR] Carrera fallida, activando Fallback YTDL...`, true));
        try {
            if (isAudio) {
                const res = await ytmp3_direct(url);
                mediaResult = { download: res.buffer, title: res.title, winner: 'YTDL-Direct', isBuffer: true };
            } else {
                const info = await ytdl.getInfo(url);
                const format = ytdl.chooseFormat(info.formats, { quality: '18' });
                mediaResult = { download: format.url, title: info.videoDetails.title, winner: 'YTDL-Core' };
            }
        } catch { return null }
    }

    if (mediaResult) console.log(colorize(`[ENVIADO] Ganador: ${mediaResult.winner}`));
    return mediaResult;
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch fail`);
    return res.buffer();
}

export { 
    raceWithFallback, cleanFileName, getBufferFromUrl, colorize, 
    ytSearch, verificarRepo, ytmp4_socdown as ytmp4, ytmp3_direct as ytmp3 
}
