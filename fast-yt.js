import fetch from "node-fetch"
import axios from "axios"
import crypto from "crypto"
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import https from 'https'

const jar = new CookieJar()
const client = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false })
}))

const getHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://yt.savetube.me',
    'Referer': 'https://yt.savetube.me/'
})

const CONFIG = {
    V_QUALITY: '360',
    A_BITRATE: '128',
    WAIT_TIME: 2500 // Tiempo entre chequeos de descarga
}

// --- UTILS ---
function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', cyan: '\x1b[36m', red: '\x1b[31m' }
    let color = text.includes('ERROR') || isError ? codes.red : codes.cyan
    return `${color}${text}${codes.reset}`
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// --- MÓDULO SAVETUBE (VIDEO Y AUDIO) ---
const savetube = {
    api: 'https://media.savetube.me/api',
    youtube: (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/)?.[1],
    
    async download(url, type) {
        const id = this.youtube(url)
        if (!id) return null
        
        try {
            // 1. Obtener CDN aleatorio
            const cdnRes = await client.get(`${this.api}/random-cdn`, { headers: getHeaders() })
            const cdn = cdnRes.data.cdn
            
            // 2. Obtener Info y Key
            const infoRes = await client.post(`https://${cdn}${this.api}/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers: getHeaders() })
            
            // Decriptar Key (AES-128-CBC)
            const keyRaw = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
            const data = Buffer.from(infoRes.data.data, 'base64')
            const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyRaw, 'hex'), data.slice(0, 16))
            const decrypted = Buffer.concat([decipher.update(data.slice(16)), decipher.final()])
            const { key, title } = JSON.parse(decrypted.toString())

            // 3. Solicitar descarga
            const dlRes = await client.post(`https://${cdn}${this.api}/download`, {
                id,
                downloadType: type,
                quality: type === 'audio' ? CONFIG.A_BITRATE : CONFIG.V_QUALITY,
                key
            }, { headers: getHeaders() })

            return { download: dlRes.data.data.downloadUrl, title }
        } catch (e) { return null }
    }
}

// --- MÓDULO YTMP3 (AUDIO RÁPIDO) ---
async function ytmp3(url) {
    try {
        const res = await client.post('https://hub.y2mp3.co/', {
            url, downloadMode: "audio", audioFormat: "mp3", audioBitrate: CONFIG.A_BITRATE
        }, { headers: getHeaders(), timeout: 10000 })
        return res.data.url || null
    } catch { return null }
}

// --- LÓGICA DE CARRERA ---
async function raceWithFallback(url, isAudio, title) {
    if (isAudio) {
        // Para audio, intentamos YTMP3 primero por ser el más rápido
        const fastAudio = await ytmp3(url)
        if (fastAudio) return { download: fastAudio, title, winner: 'YTMP3' }
    }

    // Si falla o es video, usamos Savetube con 360p
    const res = await savetube.download(url, isAudio ? 'audio' : 'video')
    if (res && res.download) {
        return { ...res, winner: 'Savetube' }
    }

    return null
}

async function getBufferFromUrl(url) {
    const res = await fetch(url, { headers: getHeaders() })
    return res.buffer()
}

function cleanFileName(n) { 
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50) 
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
