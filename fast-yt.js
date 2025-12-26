import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"
import cheerio from "cheerio"
import ytdl from "ytdl-core"
import { promises as fs } from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { exec } from 'child_process'
import { promisify } from 'util'

const execPromise = promisify(exec)

const fastAgent = {
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 200, freeSocketTimeout: 60000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 200, freeSocketTimeout: 60000 }),
};

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
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 3000,
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 8,
    VIDEO_TIMEOUT: 1200,
    AUDIO_FALLBACK_TIMEOUT: 40,
    FALLBACK_RACE_TIMEOUT: 4000
}

const cache = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CONFIG.CACHE_DURATION) {
            cache.delete(key)
        }
    }
}, 3600000).unref()

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

async function ytSearch(query) {
    try {
        const { data } = await axios.request({
            baseURL: "https://youtube.com",
            url: "/results",
            params: { search_query: query },
            ...fastAgent
        }).catch((e) => e?.response)
        const $ = cheerio.load(data)
        let _string = ""
        $("script").each((i, e) => {
            const html = $(e).html();
            if (html.includes("var ytInitialData = ")) {
                _string += html.replace(/var ytInitialData = /i, "").replace(/;$/, "")
            }
        })
        const _initData = JSON.parse(_string).contents.twoColumnSearchResultsRenderer.primaryContents
        const Results = []
        let _render = null
        if (_initData.sectionListRenderer) {
            _render = _initData.sectionListRenderer.contents
                .filter((item) => item?.itemSectionRenderer?.contents.filter((v) => v.videoRenderer || v.playlistRenderer || v.channelRenderer))
                .shift().itemSectionRenderer.contents
        }
        for (const item of _render) {
            if (item.videoRenderer && item.videoRenderer.lengthText) {
                const video = item.videoRenderer
                Results.push({
                    title: video?.title?.runs[0]?.text || "",
                    duration: video?.lengthText?.simpleText || "",
                    thumbnail: video?.thumbnail?.thumbnails[video?.thumbnail?.thumbnails.length - 1].url || "",
                    uploaded: video?.publishedTimeText?.simpleText || "",
                    views: video?.viewCountText?.simpleText?.replace(/[^0-9.]/g, "") || "",
                    url: "https://www.youtube.com/watch?v=" + video.videoId,
                })
            }
        }
        return Results
    } catch (e) {
        return { error: true, message: String(e) }
    }
}

async function ytdlp_wrapper(url, isAudio) {
    try {
        const format = isAudio ? 'bestaudio/best' : '18/best[height<=360]'
        const { stdout } = await execPromise(`yt-dlp --no-warnings --get-url -f "${format}" "${url}"`)
        const directUrl = stdout.trim().split('\n')[0]
        if (!directUrl) throw new Error()
        return { download: directUrl, winner: 'YT-DLP' }
    } catch (e) {
        throw new Error('yt-dlp falló')
    }
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
            try { return JSON.parse(decrypted.toString()) } catch { return { title: 'Desconocido', duration: '??', key: null } }
        },
    },
    isUrl: (str) => /youtube.com|youtu.be/.test(str),
    youtube: (url) => {
        const patterns = [/watch\?v=([a-zA-Z0-9_-]{11})/, /embed\/([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /shorts\/([a-zA-Z0-9_-]{11})/]
        for (let p of patterns) { if (p.test(url)) return url.match(p)[1] }
        return null
    },
    request: async (endpoint, data = {}, method = 'post') => {
        try {
            const { data: res } = await axios({
                method,
                url: `${endpoint.startsWith('http') ? '' : savetube.api.base}${endpoint}`,
                data,
                headers: savetube.headers,
                timeout: 3000,
                ...fastAgent
            })
            return { status: true, data: res }
        } catch (err) { return { status: false, error: err.message } }
    },
    getCDN: async () => {
        const cached = cache.get('savetube_cdn')
        if (cached && Date.now() - cached.timestamp < 600000) return { status: true, data: cached.data }
        const r = await savetube.request(savetube.api.cdn, {}, 'get')
        if (r.status) cache.set('savetube_cdn', { data: r.data.cdn, timestamp: Date.now() })
        return r
    },
    download: async (link, type = 'audio', quality = '360') => { 
        const id = savetube.youtube(link)
        if (!id) return { status: false }
        try {
            const cdnx = await savetube.getCDN()
            const cdn = cdnx.data
            const info = await savetube.request(`https://${cdn}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` })
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            const downloadData = await savetube.request(`https://${cdn}${savetube.api.download}`, {
                id, downloadType: type, quality: type === 'audio' ? '128' : quality, key: decrypted.key,
            })
            return { status: true, result: { title: decrypted.title, download: downloadData.data?.data?.downloadUrl } }
        } catch (err) { return { status: false } }
    },
}

async function processDownloadWithRetry_savetube(isAudio, url, retryCount = 0, videoQuality = '360') {
    const type = isAudio ? 'audio' : 'video'
    let result = await savetube.download(url, type, videoQuality) 
    if (!result.status && retryCount < 1) return processDownloadWithRetry_savetube(isAudio, url, retryCount + 1, '240')
    return result
}

class YTDown {
    constructor() {
        this.ref = 'https://ytdown.to/es2/'; this.origin = 'https://ytdown.to'
        this.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    async req(url, dat) {
        const res = await axios({ method: 'POST', url, headers: { 'User-Agent': this.ua, 'Referer': this.ref }, data: dat, ...fastAgent })
        return res.data
    }
    async ytdownV2(ytUrl, fmt = 'MP3') {
        const info = await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(ytUrl)}`)
        const med = (info.api?.mediaItems || []).filter(it => it.type === (fmt === 'MP3' ? 'Audio' : 'Video'))[0]
        for (let i = 0; i < 5; i++) {
            const res = await this.req('https://ytdown.to/proxy.php', `url=${encodeURIComponent(med.mediaUrl)}`)
            if (res.api?.fileUrl) return res.api.fileUrl
            await sleep(1000)
        }
        return med.mediaUrl
    }
}

const ytdownV2 = async (ytUrl, fmt = 'MP3') => { return new YTDown().ytdownV2(ytUrl, fmt) }

async function processDownload_y2down(videoUrl, mediaType, quality = null) {
    const format = quality || mediaType
    const initUrl = `https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`
    const data = await (await fetch(initUrl, { agent: fastAgent.httpsAgent })).json()
    for (let i = 0; i < 8; i++) {
        await sleep(1500)
        const pd = await (await fetch(`https://p.savenow.to/api/progress?id=${data.id}`, { agent: fastAgent.httpsAgent })).json()
        if (pd.progress === 1000 && pd.download_url) return pd.download_url
    }
    throw new Error()
}

async function descargarAudioYouTube(urlVideo) {
    const res = await axios.post('https://hub.y2mp3.co/', { url: urlVideo, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128" }, { ...fastAgent })
    return { success: true, downloadUrl: res.data.url }
}

async function ytmp4_socdown(url) {
    const res = await axios.post('https://socdown.com/wp-json/aio-dl/video-data/', { url }, { ...fastAgent })
    return res.data.medias.find(m => m.extension === 'mp4')?.url
}

async function ytmp3_direct(url) {
    const { videoDetails } = await ytdl.getInfo(url);
    const stream = ytdl(url, { filter: "audioonly", quality: 140 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), title: videoDetails.title };
}

const savetube_wrapper = (u, a, t) => processDownloadWithRetry_savetube(a, u, 0, '360').then(r => ({ download: r.result.download, title: t, winner: 'Savetube' }))
const ytdownV2_wrapper = (u, a, t) => ytdownV2(u, a ? 'MP3' : 'MP4').then(d => ({ download: d, title: t, winner: 'Ytdown.to' }))
const yt2dow_cc_wrapper = (u, a, t) => processDownload_y2down(u, a ? 'mp3' : '360').then(d => ({ download: d, title: t, winner: 'Yt2dow.cc' }))
const ytdown_gg_wrapper = (u, t) => descargarAudioYouTube(u).then(r => ({ download: r.downloadUrl, title: t, winner: 'Ytmp3.gg' }))
const socdown_wrapper = (u, t) => ytmp4_socdown(u).then(d => ({ download: d, title: t, winner: 'Socdown' }))

function timeoutPromise(promise, ms, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(name)), ms)
        promise.then(v => { clearTimeout(timer); resolve(v) }).catch(e => { clearTimeout(timer); reject(e) })
    })
}

async function raceWithFallback(url, isAudio, originalTitle) {
    if (!(await verificarRepo())) return null
    const ms = isAudio ? 30000 : 45000 

    const promises = [
        timeoutPromise(ytdlp_wrapper(url, isAudio), ms, 'YT-DLP'),
        timeoutPromise(savetube_wrapper(url, isAudio, originalTitle), ms, 'Savetube'),
        timeoutPromise(ytdownV2_wrapper(url, isAudio, originalTitle), ms, 'Ytdown.to'),
        timeoutPromise(yt2dow_cc_wrapper(url, isAudio, originalTitle), ms, 'Yt2dow.cc')
    ]
    
    if (isAudio) promises.push(timeoutPromise(ytdown_gg_wrapper(url, originalTitle), ms, 'Ytmp3.gg'))
    else promises.push(timeoutPromise(socdown_wrapper(url, originalTitle), ms, 'Socdown'))

    try {
        const winner = await Promise.any(promises.map(p => p.then(res => res.download ? res : Promise.reject())))
        console.log(colorize(`[ENVIADO] Ganador: ${winner.winner}`))
        return winner
    } catch {
        try {
            if (isAudio) {
                const res = await ytmp3_direct(url);
                return { download: res.buffer, title: res.title, winner: 'YTDL-Direct', isBuffer: true };
            } else {
                const info = await ytdl.getInfo(url);
                return { download: ytdl.chooseFormat(info.formats, { quality: '18' }).url, title: info.videoDetails.title, winner: 'YTDL-Core' };
            }
        } catch { return null }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url
    const res = await fetch(url, { agent: fastAgent.httpsAgent })
    return res.buffer()
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize, ytSearch, verificarRepo, ytmp4_socdown as ytmp4, ytmp3_direct as ytmp3 }
