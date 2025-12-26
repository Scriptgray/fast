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
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 500, freeSocketTimeout: 90000 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 500, freeSocketTimeout: 90000 }),
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
        return git.includes(packageJson.repository?.url);
    } catch { return false }
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', bright: '\x1b[1m', fg: { custom_cyan: '\x1b[36m', red: '\x1b[31m', white: '\x1b[37m' } }
    let prefix = text.startsWith('[BUSCANDO]') ? '[BUSCANDO]' : text.startsWith('[ENVIADO]') ? '[ENVIADO]' : (isError || text.startsWith('[ERROR]')) ? '[ERROR]' : ''
    if (!prefix) return `\x1b[37m${text}\x1b[0m`
    let colorCode = prefix === '[ERROR]' ? codes.fg.red : codes.fg.custom_cyan
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${text.substring(prefix.length).trim()}`
}

const CONFIG = {
    CACHE_DURATION: 600000,
    MAX_RETRIES: 1,
    POLLING_INTERVAL: 400, 
    SAVETUBE_RETRY_MS: 300 
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function ytSearch(query) {
    try {
        const { data } = await axios.get(`https://youtube.com/results?search_query=${encodeURIComponent(query)}`, { ...fastAgent })
        const $ = cheerio.load(data)
        let _string = ""
        $("script").each((i, e) => {
            const html = $(e).html()
            if (html.includes("var ytInitialData = ")) _string += html.replace(/var ytInitialData = /i, "").replace(/;$/, "")
        })
        const _initData = JSON.parse(_string).contents.twoColumnSearchResultsRenderer.primaryContents
        const Results = []
        let _render = _initData.sectionListRenderer.contents.filter(item => item?.itemSectionRenderer?.contents.filter(v => v.videoRenderer)).shift().itemSectionRenderer.contents
        for (const item of _render) {
            if (item.videoRenderer?.lengthText) {
                Results.push({
                    title: item.videoRenderer.title.runs[0].text,
                    duration: item.videoRenderer.lengthText.simpleText,
                    url: "https://www.youtube.com/watch?v=" + item.videoRenderer.videoId,
                })
            }
        }
        return Results
    } catch { return [] }
}

async function ytdlp_wrapper(url, isAudio) {
    try {
        const format = isAudio ? 'bestaudio/best' : '18/best'
        const { stdout } = await execPromise(`yt-dlp --no-warnings --get-url -f "${format}" "${url}"`)
        const directUrl = stdout.trim().split('\n')[0]
        if (!directUrl) throw new Error()
        return { download: directUrl, winner: 'YT-DLP' }
    } catch { throw new Error() }
}

const savetube = {
    api: { base: 'https://media.savetube.me/api', info: '/v2/info', download: '/download', cdn: '/random-cdn' },
    headers: { 'content-type': 'application/json', 'origin': 'https://yt.savetube.me', 'user-agent': 'Mozilla/5.0' },
    crypto: {
        hexToBuffer: (hex) => Buffer.from(hex.match(/.{1,2}/g).join(''), 'hex'),
        decrypt: async (enc) => {
            const key = savetube.crypto.hexToBuffer('C5D58EF67A7584E4A29F6C35BBC4EB12')
            const data = Buffer.from(enc, 'base64')
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, data.slice(0, 16))
            const decrypted = Buffer.concat([decipher.update(data.slice(16)), decipher.final()])
            return JSON.parse(decrypted.toString())
        },
    },
    download: async (link, type, quality = '360') => { 
        const id = link.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)[1]
        const { data: { cdn } } = await axios.get(savetube.api.base + savetube.api.cdn, { ...fastAgent })
        const info = await axios.post(`https://${cdn}${savetube.api.info}`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: savetube.headers, ...fastAgent })
        const decrypted = await savetube.crypto.decrypt(info.data.data)
        const dl = await axios.post(`https://${cdn}${savetube.api.download}`, { id, downloadType: type, quality: type === 'audio' ? '128' : quality, key: decrypted.key }, { headers: savetube.headers, ...fastAgent })
        return { download: dl.data.data.downloadUrl, title: decrypted.title }
    },
}

async function savetube_fast_retry(url, type, title) {
    try {
        const res = await savetube.download(url, type)
        return { download: res.download, title: res.title || title, winner: 'Savetube' }
    } catch {
        await sleep(CONFIG.SAVETUBE_RETRY_MS)
        const res = await savetube.download(url, type, '240')
        return { download: res.download, title: res.title || title, winner: 'Savetube' }
    }
}

async function y2down_fast(videoUrl, format) {
    const init = await (await fetch(`https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`, { agent: fastAgent.httpsAgent })).json()
    for (let i = 0; i < 15; i++) {
        await sleep(CONFIG.POLLING_INTERVAL)
        const pd = await (await fetch(`https://p.savenow.to/api/progress?id=${init.id}`, { agent: fastAgent.httpsAgent })).json()
        if (pd.download_url) return pd.download_url
    }
    throw new Error()
}

async function ytmp3_gg_fast(url) {
    const res = await axios.post('https://hub.y2mp3.co/', { url, downloadMode: "audio", brandName: "ytmp3.gg", audioFormat: "mp3", audioBitrate: "128" }, { ...fastAgent })
    if (res.data.url) return res.data.url
    throw new Error()
}

async function ytmp4_socdown(url) {
    const res = await axios.post('https://socdown.com/wp-json/aio-dl/video-data/', { url }, { ...fastAgent })
    const dl = res.data.medias.find(m => m.extension === 'mp4')?.url
    if (!dl) throw new Error()
    return dl
}

async function ytmp3_direct(url) {
    const info = await ytdl.getInfo(url)
    const chunks = []
    const stream = ytdl(url, { filter: "audioonly", quality: 140 })
    for await (const chunk of stream) chunks.push(chunk)
    return { buffer: Buffer.concat(chunks), title: info.videoDetails.title }
}

async function raceWithFallback(url, isAudio, originalTitle) {
    if (!(await verificarRepo())) return null
    const type = isAudio ? 'audio' : 'video'

    const tasks = [
        ytdlp_wrapper(url, isAudio).catch(() => null),
        savetube_fast_retry(url, type, originalTitle).catch(() => null),
        y2down_fast(url, isAudio ? 'mp3' : '360').then(d => ({ download: d, winner: 'Yt2dow.cc' })).catch(() => null)
    ]

    if (isAudio) tasks.push(ytmp3_gg_fast(url).then(d => ({ download: d, winner: 'Ytmp3.gg' })).catch(() => null))
    else tasks.push(ytmp4_socdown(url).then(d => ({ download: d, winner: 'Socdown' })).catch(() => null))

    try {
        const winner = await Promise.any(tasks.filter(t => t !== null).map(p => p.then(res => (res && res.download) ? res : Promise.reject())))
        console.log(colorize(`[ENVIADO] Ganador: ${winner.winner}`))
        return winner
    } catch {
        try {
            if (isAudio) {
                const res = await ytmp3_direct(url)
                return { download: res.buffer, title: res.title, winner: 'YTDL-Direct', isBuffer: true }
            } else {
                const info = await ytdl.getInfo(url)
                return { download: ytdl.chooseFormat(info.formats, { quality: '18' }).url, title: info.videoDetails.title, winner: 'YTDL-Core' }
            }
        } catch { return null }
    }
}

async function getBufferFromUrl(url) {
    if (Buffer.isBuffer(url)) return url
    try {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 10000,
            ...fastAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/'
            }
        })
        return Buffer.from(response.data)
    } catch (e) {
        const res = await fetch(url, { agent: fastAgent.httpsAgent })
        return Buffer.from(await res.arrayBuffer())
    }
}

const cleanFileName = (n) => n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50)

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize, ytSearch, verificarRepo }
