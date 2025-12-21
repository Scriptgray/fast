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
    httpsAgent: new https.Agent({ 
        keepAlive: true, 
        rejectUnauthorized: false,
        timeout: 60000 
    })
}))

const CONFIG = {
    V_QUALITY: '360', // Calidad de video balanceada (rápida y compatible)
    A_BITRATE: '128', // Calidad de audio estándar completa
    MAX_TIMEOUT: 15000
}

const getHeaders = (origin = 'savetube') => {
    const base = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': '*/*'
    }
    if (origin === 'savetube') {
        base['Origin'] = 'https://yt.savetube.me'
        base['Referer'] = 'https://yt.savetube.me/'
    }
    return base
}

const savetube = {
    api: 'https://media.savetube.me/api',
    youtube: (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/)?.[1],
    
    async download(url, type) {
        const id = this.youtube(url)
        if (!id) return null
        
        try {
            // 1. Obtener CDN estable
            const cdnRes = await client.get(`${this.api}/random-cdn`, { headers: getHeaders() })
            const cdn = cdnRes.data.cdn
            
            // 2. Obtener Metadata y Key
            const infoRes = await client.post(`https://${cdn}${this.api}/v2/info`, { 
                url: `https://www.youtube.com/watch?v=${id}` 
            }, { headers: getHeaders() })
            
            if (!infoRes.data?.data) return null

            // Decriptar Key correctamente
            const secret = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
            const encryptedData = Buffer.from(infoRes.data.data, 'base64')
            const iv = encryptedData.slice(0, 16)
            const payload = encryptedData.slice(16)
            const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(secret, 'hex'), iv)
            const decrypted = Buffer.concat([decipher.update(payload), decipher.final()])
            const { key, title } = JSON.parse(decrypted.toString())

            // 3. Obtener Link Final
            const dlRes = await client.post(`https://${cdn}${this.api}/download`, {
                id,
                downloadType: type,
                quality: type === 'audio' ? CONFIG.A_BITRATE : CONFIG.V_QUALITY,
                key
            }, { headers: getHeaders() })

            return { 
                download: dlRes.data.data.downloadUrl, 
                title: title || 'YouTube Media' 
            }
        } catch (e) {
            return null
        }
    }
}

// Motor alternativo para Audio Completo (128kbps)
async function ytmp3_alt(url) {
    try {
        const res = await client.post('https://hub.y2mp3.co/', {
            url, 
            downloadMode: "audio", 
            audioFormat: "mp3", 
            audioBitrate: CONFIG.A_BITRATE
        }, { 
            headers: getHeaders('ytmp3'), 
            timeout: CONFIG.MAX_TIMEOUT 
        })
        return res.data?.url || null
    } catch {
        return null
    }
}

async function raceWithFallback(url, isAudio, title) {
    // Si es audio, intentamos primero el servidor dedicado de MP3 para evitar cortes
    if (isAudio) {
        const audio = await ytmp3_alt(url)
        if (audio) return { download: audio, title, winner: 'YTMP3' }
    }

    // Para Video o si falló el anterior, usamos Savetube
    const res = await savetube.download(url, isAudio ? 'audio' : 'video')
    if (res && res.download) {
        return { ...res, winner: 'Savetube' }
    }

    return null
}

async function getBufferFromUrl(url) {
    try {
        const res = await fetch(url, { 
            headers: getHeaders(),
            timeout: 0 // Permitir descargas largas sin corte
        })
        if (!res.ok) throw new Error(`Status ${res.status}`)
        return await res.buffer()
    } catch (e) {
        throw new Error(`Error en buffer: ${e.message}`)
    }
}

function colorize(text, isError = false) {
    const codes = { reset: '\x1b[0m', cyan: '\x1b[36m', red: '\x1b[31m' }
    let color = isError || text.includes('ERROR') ? codes.red : codes.cyan
    return `${color}${text}${codes.reset}`
}

function cleanFileName(n) { 
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50) 
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
