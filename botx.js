require('dotenv').config();
const { Bot, InputFile } = require("grammy");
const Tiktok = require("@tobyg74/tiktok-api-dl");
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const cluster = require('cluster');
const os = require('os');

// Bot Token from environment variable
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN tidak ditemukan di file .env!');
    console.error('💡 Buat file .env dan tambahkan: BOT_TOKEN=your_bot_token_here');
    process.exit(1);
}

// Advanced Configuration
const ADVANCED_CONFIG = {
    maxConcurrentUsers: 50, // Maximum concurrent users
    maxConcurrentDownloads: 20, // Maximum concurrent downloads per user
    maxConcurrentUploads: 10, // Maximum concurrent uploads per user
    downloadTimeout: 60000, // 60 seconds timeout per download
    uploadTimeout: 120000, // 2 minutes timeout per upload
    maxRetries: 3,
    useWorkerThreads: false, // Set to true for worker threads (experimental)
    connectionPoolSize: 50, // HTTP connection pool size
    memoryThreshold: 1024 * 1024 * 1024, // 1GB memory threshold
    cleanupInterval: 30000, // 30 seconds cleanup interval
};

// Resource Management
class ResourceManager {
    constructor() {
        this.activeUsers = new Map();
        this.downloadSemaphore = new Semaphore(ADVANCED_CONFIG.maxConcurrentDownloads);
        this.uploadSemaphore = new Semaphore(ADVANCED_CONFIG.maxConcurrentUploads);
        this.userSemaphore = new Semaphore(ADVANCED_CONFIG.maxConcurrentUsers);
        this.httpAgent = new (require('https').Agent)({
            keepAlive: true,
            maxSockets: ADVANCED_CONFIG.connectionPoolSize,
            maxFreeSockets: 10,
            timeout: 30000,
            freeSocketTimeout: 4000,
        });
        
        // Start cleanup interval
        this.startCleanupInterval();
    }
    
    async acquireUserSlot(userId) {
        await this.userSemaphore.acquire();
        this.activeUsers.set(userId, Date.now());
    }
    
    releaseUserSlot(userId) {
        this.activeUsers.delete(userId);
        this.userSemaphore.release();
    }
    
    async acquireDownloadSlot() {
        await this.downloadSemaphore.acquire();
    }
    
    releaseDownloadSlot() {
        this.downloadSemaphore.release();
    }
    
    async acquireUploadSlot() {
        await this.uploadSemaphore.acquire();
    }
    
    releaseUploadSlot() {
        this.uploadSemaphore.release();
    }
    
    getHttpAgent() {
        return this.httpAgent;
    }
    
    getActiveUsersCount() {
        return this.activeUsers.size;
    }
    
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupResources();
        }, ADVANCED_CONFIG.cleanupInterval);
    }
    
    cleanupResources() {
        const now = Date.now();
        const timeout = 5 * 60 * 1000; // 5 minutes timeout
        
        for (const [userId, timestamp] of this.activeUsers.entries()) {
            if (now - timestamp > timeout) {
                log(`Cleaning up stale user session: ${userId}`, 'INFO', 'yellow');
                this.releaseUserSlot(userId);
            }
        }
        
        // Memory cleanup
        if (process.memoryUsage().heapUsed > ADVANCED_CONFIG.memoryThreshold) {
            log('Memory threshold exceeded, forcing garbage collection', 'WARN', 'yellow');
            if (global.gc) {
                global.gc();
            }
        }
    }
}

// Semaphore implementation for concurrency control
class Semaphore {
    constructor(permits) {
        this.permits = permits;
        this.waiters = [];
    }
    
    async acquire() {
        return new Promise((resolve) => {
            if (this.permits > 0) {
                this.permits--;
                resolve();
            } else {
                this.waiters.push(resolve);
            }
        });
    }
    
    release() {
        this.permits++;
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            this.permits--;
            waiter();
        }
    }
}

// Initialize Resource Manager
const resourceManager = new ResourceManager();

// Initialize Bot with concurrency optimization
const bot = new Bot(BOT_TOKEN, {
    // Enable concurrent message processing
    botInfo: undefined, // Will be set during start
    // Remove default rate limiting
    client: {
        timeoutSeconds: 60,
        retryCount: 3,
        environment: "prod"
    }
});

// Enable concurrent processing by removing sequential middleware
bot.use(async (ctx, next) => {
    // Process each message in parallel without waiting
    setImmediate(async () => {
        try {
            await next();
        } catch (error) {
            logError(error, `Middleware error for user ${ctx.from?.id}`);
        }
    });
});

// Cookie management
let cookieString = null;

// Auto-delete configuration
const AUTO_DELETE_CONFIG = {
    enabled: true,
    deleteDelay: 2000,
    onlyInGroups: true,
    deleteStatusMessages: true
};

// API version configuration
const API_CONFIG = {
    retryWithV2OnV1Failure: true,
    v1MaxRetries: 1,
    v2MaxRetries: 2
};

// Logging colors
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m'
};

// Enhanced logging function with user tracking
function log(message, level = 'INFO', color = 'reset', userId = null) {
    const timestamp = new Date().toISOString();
    const userInfo = userId ? ` [User:${userId}]` : '';
    const activeUsers = resourceManager.getActiveUsersCount();
    const logMessage = `[${timestamp}] [${level}]${userInfo} [Active:${activeUsers}] ${message}`;
    console.log(colors[color] + logMessage + colors.reset);
}

// Error monitoring function
function logError(error, context = '', userId = null) {
    log(`ERROR in ${context}: ${error.message}`, 'ERROR', 'red', userId);
    if (error.stack && process.env.NODE_ENV === 'development') {
        log(`Stack trace: ${error.stack}`, 'ERROR', 'red', userId);
    }
}

// Check if chat is a group
function isGroupChat(ctx) {
    return ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
}

// Check if bot can delete messages in the chat
async function canDeleteMessages(ctx) {
    try {
        const chatMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
        return chatMember.can_delete_messages || chatMember.status === 'administrator' || chatMember.status === 'creator';
    } catch (error) {
        log(`Cannot check delete permissions: ${error.message}`, 'WARN', 'yellow', ctx.from?.id);
        return false;
    }
}

// Safe message deletion with error handling
async function safeDeleteMessage(ctx, messageId = null, delay = 0) {
    if (!AUTO_DELETE_CONFIG.enabled) return;
    
    const targetMessageId = messageId || ctx.message.message_id;
    
    try {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await ctx.api.deleteMessage(ctx.chat.id, targetMessageId);
        log(`Deleted message ${targetMessageId} in chat ${ctx.chat.id}`, 'INFO', 'blue', ctx.from?.id);
        return true;
    } catch (error) {
        if (!error.message.includes('message to delete not found')) {
            log(`Failed to delete message ${targetMessageId}: ${error.message}`, 'WARN', 'yellow', ctx.from?.id);
        }
        return false;
    }
}

// Load cookies from file if exists
function loadCookies() {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    
    try {
        if (fs.existsSync(cookiesPath)) {
            cookieString = fs.readFileSync(cookiesPath, 'utf8').trim();
            log('✅ Cookies loaded from cookies.txt', 'INFO', 'green');
            log(`Cookie preview: ${cookieString.substring(0, 100)}...`, 'INFO', 'blue');
            return true;
        } else {
            log('⚠️ cookies.txt not found, proceeding without cookies', 'WARN', 'yellow');
            return false;
        }
    } catch (error) {
        logError(error, 'loadCookies');
        log('⚠️ Failed to load cookies, proceeding without them', 'WARN', 'yellow');
        return false;
    }
}

// Get axios config with connection pooling and optimization
function getAxiosConfig(useCookies = false) {
    const config = {
        timeout: ADVANCED_CONFIG.downloadTimeout,
        maxRedirects: 10,
        httpsAgent: resourceManager.getHttpAgent(),
        maxContentLength: 500 * 1024 * 1024, // 500MB max file size
        maxBodyLength: 500 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
            'Referer': 'https://www.tiktok.com/'
        }
    };
    
    if (useCookies && cookieString) {
        config.headers['Cookie'] = cookieString;
        log('🍪 Using cookies for request', 'INFO', 'cyan');
    }
    
    return config;
}

// Enhanced TikTok data fetching with concurrent API calls
async function fetchTikTokData(url, userId) {
    let lastError = null;
    
    // Create promises for both API versions to run concurrently
    const apiPromises = [];
    
    // Add v1 API promise
    if (API_CONFIG.v1MaxRetries > 0) {
        apiPromises.push(
            (async () => {
                for (let attempt = 1; attempt <= API_CONFIG.v1MaxRetries; attempt++) {
                    try {
                        log(`Attempting v1 API (attempt ${attempt}/${API_CONFIG.v1MaxRetries}): ${url}`, 'INFO', 'blue', userId);
                        
                        const result = await Tiktok.Downloader(url, { version: "v1" });
                        
                        if (result && result.status === "success" && result.result) {
                            log('✅ v1 API successful', 'INFO', 'green', userId);
                            return { ...result, apiVersion: 'v1' };
                        } else {
                            throw new Error(result?.message || "v1 API returned unsuccessful status");
                        }
                        
                    } catch (error) {
                        lastError = error;
                        log(`v1 API attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow', userId);
                        
                        if (attempt < API_CONFIG.v1MaxRetries) {
                            const delay = Math.min(Math.pow(2, attempt) * 1000, 5000); // Max 5s delay
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                    }
                }
                throw lastError;
            })()
        );
    }
    
    // Add v2 API promise if fallback is enabled
    if (API_CONFIG.retryWithV2OnV1Failure && API_CONFIG.v2MaxRetries > 0) {
        apiPromises.push(
            (async () => {
                // Wait a bit before trying v2 to give v1 a chance
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                for (let attempt = 1; attempt <= API_CONFIG.v2MaxRetries; attempt++) {
                    try {
                        log(`Attempting v2 API (attempt ${attempt}/${API_CONFIG.v2MaxRetries}): ${url}`, 'INFO', 'blue', userId);
                        
                        const result = await Tiktok.Downloader(url, { version: "v2" });
                        
                        if (result && result.status === "success" && result.result) {
                            log('✅ v2 API successful', 'INFO', 'green', userId);
                            return { ...result, apiVersion: 'v2' };
                        } else {
                            throw new Error(result?.message || "v2 API returned unsuccessful status");
                        }
                        
                    } catch (error) {
                        lastError = error;
                        log(`v2 API attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow', userId);
                        
                        if (attempt < API_CONFIG.v2MaxRetries) {
                            const delay = Math.min(Math.pow(2, attempt) * 1000, 5000);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                    }
                }
                throw lastError;
            })()
        );
    }
    
    // Race the API calls - return first successful result
    try {
        const result = await Promise.any(apiPromises);
        return result;
    } catch (error) {
        // All APIs failed
        throw new Error(`Both v1 and v2 APIs failed. Last error: ${lastError?.message || 'Unknown error'}`);
    }
}

// Enhanced download function with semaphore and streaming optimization
async function downloadFile(url, filename, userId, retries = 3, useCookies = false) {
    await resourceManager.acquireDownloadSlot();
    
    try {
        let lastError = null;
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                log(`Download attempt ${attempt}/${retries} for: ${path.basename(filename)} ${useCookies ? '(with cookies)' : ''}`, 'INFO', 'blue', userId);
                
                const config = getAxiosConfig(useCookies);
                const response = await axios({
                    ...config,
                    method: 'GET',
                    url: url,
                    responseType: 'stream'
                });
                
                // Create write stream with optimized buffer
                const writer = fs.createWriteStream(filename, { 
                    highWaterMark: 64 * 1024 // 64KB buffer
                });
                
                // Stream with progress tracking
                let downloadedBytes = 0;
                const totalBytes = parseInt(response.headers['content-length']) || 0;
                
                response.data.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                        if (downloadedBytes % (1024 * 1024) === 0) { // Log every MB
                            log(`Download progress: ${progress}% (${Math.round(downloadedBytes / 1024 / 1024)}MB)`, 'INFO', 'cyan', userId);
                        }
                    }
                });
                
                response.data.pipe(writer);
                
                return new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        const stats = fs.statSync(filename);
                        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                        log(`File downloaded successfully: ${path.basename(filename)} (${sizeMB} MB)`, 'INFO', 'green', userId);
                        resolve({ filename, size: stats.size, sizeMB });
                    });
                    
                    writer.on('error', (err) => {
                        fs.unlink(filename, () => {});
                        reject(err);
                    });
                    
                    response.data.on('error', (err) => {
                        writer.destroy();
                        fs.unlink(filename, () => {});
                        reject(err);
                    });
                    
                    // Timeout handling
                    const timeoutId = setTimeout(() => {
                        writer.destroy();
                        fs.unlink(filename, () => {});
                        reject(new Error('Download timeout'));
                    }, ADVANCED_CONFIG.downloadTimeout);
                    
                    writer.on('finish', () => clearTimeout(timeoutId));
                    writer.on('error', () => clearTimeout(timeoutId));
                });
                
            } catch (error) {
                lastError = error;
                log(`Download attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow', userId);
                
                // Clean up failed download
                if (fs.existsSync(filename)) {
                    fs.unlink(filename, () => {});
                }
                
                // Smart retry logic
                if (attempt === 1 && !useCookies && cookieString && 
                    (error.response?.status === 403 || error.code === 'ECONNREFUSED')) {
                    log('🍪 First attempt failed, will try with cookies on next attempt', 'INFO', 'yellow', userId);
                    useCookies = true;
                }
                
                if (attempt < retries) {
                    const delay = Math.min(Math.pow(2, attempt) * 1000, 10000); // Max 10s delay
                    log(`Retrying in ${delay}ms...`, 'INFO', 'yellow', userId);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        throw new Error(`Failed to download after ${retries} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
        
    } finally {
        resourceManager.releaseDownloadSlot();
    }
}

// Format timestamp to readable date
function formatTimestamp(timestamp) {
    try {
        const date = new Date(parseInt(timestamp) * 1000);
        return date.toLocaleDateString('id-ID', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'Asia/Jakarta'
        });
    } catch (error) {
        logError(error, 'formatTimestamp');
        return 'Unknown date';
    }
}

// Get best quality video URL with fallback options
function getBestVideoUrl(videoData, apiVersion = 'v1') {
    if (!videoData || !videoData.video) return null;
    
    let videoSources = [];
    
    if (apiVersion === 'v2') {
        if (videoData.video.playAddr && Array.isArray(videoData.video.playAddr)) {
            videoSources = videoData.video.playAddr;
            log(`v2 API: Found ${videoSources.length} video sources`, 'INFO', 'cyan');
        }
    } else {
        videoSources = [
            videoData.video.playAddr,
            videoData.video.downloadAddr,
            videoData.video.play,
            videoData.video.noWaterMark,
            videoData.video.watermark
        ].filter(Boolean);
    }
    
    let bestUrl = videoSources[0];
    if (Array.isArray(bestUrl)) {
        bestUrl = bestUrl[0];
    }
    
    log(`Found ${videoSources.length} video sources (${apiVersion}), using: ${bestUrl?.substring(0, 100)}...`, 'INFO', 'cyan');
    return bestUrl;
}

// Check if TikTok URL is valid
function isValidTikTokUrl(url) {
    const tiktokRegex = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)/i;
    return tiktokRegex.test(url);
}

// Extract URLs from message
function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = text.match(urlRegex) || [];
    return urls.filter(url => isValidTikTokUrl(url));
}

// Generate enhanced caption
function generateCaption(data, isPhoto = false, fileSize = null, apiVersion = 'v1') {
    const createTime = formatTimestamp(data.createTime || data.create_time);
    const uid = data.author?.uid || data.author?.id || 'Unknown';
    const username = data.author?.uniqueId || data.author?.username || data.author?.nickname || 'Unknown';
    const videoId = data.id || data.aweme_id || 'Unknown';
    
    const originalUrl = data.url || data.webVideoUrl || `https://www.tiktok.com/@${username}/${isPhoto ? 'photo' : 'video'}/${videoId}`;
    
    let caption = `📅 ${createTime}\n`;
    caption += `👤 UID: ${uid}\n`;
    caption += `👤 Username: [${username}](${originalUrl})\n`;
    
    if (fileSize) {
        caption += `📁 Size: ${fileSize} MB\n`;
    }
    
    caption += `🔧 API: ${apiVersion.toUpperCase()}\n`;
    caption += `🔗 [Link TikTok](${originalUrl})`;
    
    const description = data.desc || data.description || '';
    if (description && description.trim()) {
        const cleanDesc = description.trim().substring(0, 300);
        caption += `\n\n📝 "${cleanDesc}${description.length > 300 ? '...' : ''}"`;
    }
    
    return caption;
}

// Main TikTok processing function with advanced concurrency
async function processTikTokUrl(ctx, url) {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const isGroup = isGroupChat(ctx);
    const originalMessageId = ctx.message.message_id;
    
    // Acquire user slot for resource management
    await resourceManager.acquireUserSlot(userId);
    
    try {
        log(`Processing TikTok URL from user ${username} (${userId}) in ${isGroup ? 'group' : 'private'}: ${url}`, 'INFO', 'cyan', userId);
        
        let statusMessage = null;
        let canDelete = false;
        
        // Check deletion permissions if in group
        if (isGroup && AUTO_DELETE_CONFIG.enabled) {
            canDelete = await canDeleteMessages(ctx);
            if (canDelete) {
                log('Bot has permission to delete messages in this group', 'INFO', 'blue', userId);
            } else {
                log('Bot cannot delete messages in this group', 'WARN', 'yellow', userId);
            }
        }
        
        // Show typing indicator
        await ctx.replyWithChatAction("typing");
        
        // Send initial message
        statusMessage = await ctx.reply("📄 Mengunduh konten TikTok...");
        
        // Get TikTok data with concurrent API calls
        log(`Fetching TikTok data for: ${url}`, 'INFO', 'blue', userId);
        const result = await fetchTikTokData(url, userId);
        
        const data = result.result;
        const apiVersion = result.apiVersion || 'v1';
        
        log(`Successfully fetched TikTok data using ${apiVersion.toUpperCase()} API. Type: ${data.type}`, 'INFO', 'green', userId);
        
        // Update status message
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📥 Memproses konten..."
        );
        
        // Process content based on type
        let success = false;
        if (data.type === "image" || (data.images && data.images.length > 0)) {
            success = await handleImageSlideshow(ctx, data, statusMessage, apiVersion, userId);
        } else {
            success = await handleVideo(ctx, data, statusMessage, apiVersion, userId);
        }
        
        // Delete status message if configured
        if (AUTO_DELETE_CONFIG.deleteStatusMessages && statusMessage) {
            await safeDeleteMessage(ctx, statusMessage.message_id);
            statusMessage = null;
        }
        
        // Delete original message if successful and in group
        if (success && isGroup && AUTO_DELETE_CONFIG.enabled && 
            (!AUTO_DELETE_CONFIG.onlyInGroups || isGroup) && canDelete) {
            
            log(`Scheduling deletion of original message ${originalMessageId} in ${AUTO_DELETE_CONFIG.deleteDelay}ms`, 'INFO', 'cyan', userId);
            await safeDeleteMessage(ctx, originalMessageId, AUTO_DELETE_CONFIG.deleteDelay);
        }
        
        log(`Successfully processed TikTok URL for user ${username} using ${apiVersion.toUpperCase()} API`, 'INFO', 'green', userId);
        
    } catch (error) {
        logError(error, 'processTikTokUrl', userId);
        await ctx.reply(`❌ Gagal mengunduh konten: ${error.message}`);
    } finally {
        // Always release user slot
        resourceManager.releaseUserSlot(userId);
    }
}

// Handle video content with upload semaphore
async function handleVideo(ctx, data, statusMessage, apiVersion = 'v1', userId) {
    await resourceManager.acquireUploadSlot();
    
    try {
        let filename = null;
        
        const videoUrl = getBestVideoUrl(data, apiVersion);
        if (!videoUrl) {
            throw new Error("No video URL found in response data");
        }
        
        log(`Attempting to download video from ${apiVersion.toUpperCase()} API: ${videoUrl.substring(0, 150)}...`, 'INFO', 'blue', userId);
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📱 Mengunduh video..."
        );
        
        // Create temporary directory if not exists
        const tempDir = './temp';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Generate unique filename with user ID
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substring(2, 15);
        filename = path.join(tempDir, `video_${userId}_${timestamp}_${randomId}.mp4`);
        
        // Download video
        const downloadResult = await downloadFile(videoUrl, filename, userId);
        
        // Verify file
        if (downloadResult.size === 0) {
            throw new Error("Downloaded file is empty");
        }
        
        if (downloadResult.size < 1024) {
            throw new Error("Downloaded file is too small, likely an error response");
        }
        
        log(`Video downloaded successfully: ${path.basename(filename)} (${downloadResult.sizeMB} MB)`, 'INFO', 'green', userId);
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📤 Mengirim video..."
        );
        
        // Generate caption
        const caption = generateCaption(data, false, downloadResult.sizeMB, apiVersion);
        
        // Send video with timeout
        const uploadPromise = ctx.replyWithVideo(new InputFile(filename), {
            caption: caption,
            supports_streaming: true,
            parse_mode: "Markdown"
        });
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Upload timeout')), ADVANCED_CONFIG.uploadTimeout);
        });
        
        try {
            await Promise.race([uploadPromise, timeoutPromise]);
        } catch (sendError) {
            log(`Failed to send with Markdown, trying without: ${sendError.message}`, 'WARN', 'yellow', userId);
            try {
                await Promise.race([
                    ctx.replyWithVideo(new InputFile(filename), {
                        caption: caption,
                        supports_streaming: true
                    }),
                    timeoutPromise
                ]);
            } catch (sendError2) {
                log(`Failed to send with caption, trying without: ${sendError2.message}`, 'WARN', 'yellow', userId);
                await Promise.race([
                    ctx.replyWithVideo(new InputFile(filename), {
                        supports_streaming: true
                    }),
                    timeoutPromise
                ]);
                await ctx.reply(caption, { parse_mode: "Markdown" });
            }
        }
        
        log(`Video sent successfully using ${apiVersion.toUpperCase()} API`, 'INFO', 'green', userId);
        
        // Cleanup file immediately after successful upload
        if (filename && fs.existsSync(filename)) {
            fs.unlink(filename, (err) => {
                if (err) logError(err, 'cleanup video file', userId);
                else log(`Cleaned up temporary file: ${path.basename(filename)}`, 'INFO', 'blue', userId);
            });
        }
        
        return true;
        
    } catch (error) {
        logError(error, 'handleVideo', userId);
        
        if (error.code === 'ECONNREFUSED') {
            throw new Error("Koneksi ditolak server TikTok. Coba lagi dalam beberapa menit.");
        } else if (error.code === 'ETIMEDOUT') {
            throw new Error("Timeout saat mengunduh video. Video mungkin terlalu besar atau koneksi lambat.");
        } else if (error.message.includes('403')) {
            throw new Error("Akses ke video ditolak. Video mungkin private atau region-blocked.");
        } else if (error.message.includes('404')) {
            throw new Error("Video tidak ditemukan. Link mungkin sudah expired atau dihapus.");
        }
        
        throw error;
    } finally {
        resourceManager.releaseUploadSlot();
    }
}

// Handle image slideshow with advanced concurrency
async function handleImageSlideshow(ctx, data, statusMessage, apiVersion = 'v1', userId) {
    await resourceManager.acquireUploadSlot();
    
    try {
        const filenames = [];
        const downloadResults = [];
        
        const images = data.images || [];
        if (images.length === 0) {
            throw new Error("No images found in slideshow data");
        }
        
        log(`Processing ${images.length} images from slideshow using ${apiVersion.toUpperCase()} API`, 'INFO', 'blue', userId);
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            `📸 Mengunduh ${images.length} gambar...`
        );
        
        // Create temporary directory
        const tempDir = './temp';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Download all images concurrently with proper resource management
        const timestamp = Date.now();
        const downloadPromises = images.map(async (imageUrl, index) => {
            try {
                const randomId = Math.random().toString(36).substring(2, 8);
                const filename = path.join(tempDir, `image_${userId}_${timestamp}_${index}_${randomId}.jpg`);
                
                log(`Downloading image ${index + 1}/${images.length}`, 'INFO', 'cyan', userId);
                const result = await downloadFile(imageUrl, filename, userId);
                
                if (result.size < 1024) {
                    throw new Error(`Image ${index + 1} is too small (${result.size} bytes)`);
                }
                
                return { filename: result.filename, size: result.size, sizeMB: result.sizeMB };
            } catch (error) {
                logError(error, `download image ${index + 1}`, userId);
                throw new Error(`Failed to download image ${index + 1}: ${error.message}`);
            }
        });
        
        // Execute downloads with controlled concurrency
        const downloadSettledResults = await Promise.allSettled(downloadPromises);
        
        // Process results
        const successfulDownloads = [];
        const failedDownloads = [];
        
        downloadSettledResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                successfulDownloads.push(result.value);
                downloadResults.push(result.value);
                filenames.push(result.value.filename);
            } else {
                failedDownloads.push({ index: index + 1, error: result.reason.message });
            }
        });
        
        if (successfulDownloads.length === 0) {
            throw new Error("Failed to download any images");
        }
        
        if (failedDownloads.length > 0) {
            log(`Warning: ${failedDownloads.length} images failed to download`, 'WARN', 'yellow', userId);
        }
        
        // Calculate total size
        const totalSizeMB = downloadResults.reduce((sum, result) => sum + parseFloat(result.sizeMB), 0).toFixed(2);
        
        log(`Successfully downloaded ${successfulDownloads.length}/${images.length} images (${totalSizeMB} MB total) using ${apiVersion.toUpperCase()} API`, 'INFO', 'green', userId);
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            `📤 Mengirim ${successfulDownloads.length} gambar...`
        );
        
        // Generate caption
        const caption = generateCaption(data, true, totalSizeMB, apiVersion);
        
        // Send images in chunks of 10 (Telegram limit) concurrently
        const mediaGroupChunks = [];
        for (let i = 0; i < successfulDownloads.length; i += 10) {
            const chunk = successfulDownloads.slice(i, i + 10).map((result, index) => ({
                type: "photo",
                media: new InputFile(result.filename),
                caption: i === 0 && index === 0 ? caption : undefined
            }));
            mediaGroupChunks.push(chunk);
        }
        
        // Send all chunks concurrently
        const sendPromises = mediaGroupChunks.map(async (chunk, chunkIndex) => {
            try {
                await ctx.replyWithMediaGroup(chunk, { parse_mode: "Markdown" });
            } catch (sendError) {
                log(`Failed to send media group chunk ${chunkIndex + 1} with Markdown, trying without: ${sendError.message}`, 'WARN', 'yellow', userId);
                try {
                    await ctx.replyWithMediaGroup(chunk);
                } catch (sendError2) {
                    log(`Failed to send media group chunk ${chunkIndex + 1}, trying individual images: ${sendError2.message}`, 'WARN', 'yellow', userId);
                    
                    const individualPromises = chunk.map(async (item, itemIndex) => {
                        try {
                            await ctx.replyWithPhoto(item.media, {
                                caption: item.caption || undefined,
                                parse_mode: item.caption ? "Markdown" : undefined
                            });
                        } catch (individualError) {
                            logError(individualError, `send individual image from chunk ${chunkIndex + 1}, item ${itemIndex + 1}`, userId);
                        }
                    });
                    
                    await Promise.allSettled(individualPromises);
                }
            }
        });
        
        await Promise.allSettled(sendPromises);
        
        // Cleanup files immediately
        filenames.forEach(filename => {
            if (fs.existsSync(filename)) {
                fs.unlink(filename, (err) => {
                    if (err) logError(err, 'cleanup image file', userId);
                    else log(`Cleaned up temporary file: ${path.basename(filename)}`, 'INFO', 'blue', userId);
                });
            }
        });
        
        if (failedDownloads.length > 0) {
            await ctx.reply(`⚠️ ${failedDownloads.length} gambar gagal diunduh dari total ${images.length} gambar.`);
        }
        
        log(`Image slideshow sent successfully (${successfulDownloads.length} images, ${totalSizeMB} MB total) using ${apiVersion.toUpperCase()} API`, 'INFO', 'green', userId);
        return true;
        
    } catch (error) {
        logError(error, 'handleImageSlideshow', userId);
        throw error;
    } finally {
        resourceManager.releaseUploadSlot();
    }
}

// Bot event handlers with concurrent processing
bot.command("start", async (ctx) => {
    const welcomeMessage = `
🤖 *TikTok Downloader Bot - Advanced Concurrent Version*

Selamat datang! Bot ini dapat mengunduh video dan gambar dari TikTok dengan performa tinggi.

📝 *Cara Penggunaan:*
• Kirim link TikTok ke bot
• Bot akan otomatis mengunduh dan mengirim konten
• Support video dan slideshow gambar
• Di grup, pesan link akan dihapus otomatis setelah konten terkirim

🔗 *Format Link yang Didukung:*
• https://www.tiktok.com/@username/video/123
• https://vt.tiktok.com/xxx
• https://vm.tiktok.com/xxx

🚀 *Fitur Advanced:*
• **TRUE CONCURRENT PROCESSING** - Multiple users bersamaan
• **Smart Resource Management** - Optimized for performance
• **Connection Pooling** - Fast downloads
• **Parallel API Calls** - v1 & v2 simultaneously
• **No Rate Limiting** - Unlimited requests

🔧 *Performance Stats:*
• Max Concurrent Users: ${ADVANCED_CONFIG.maxConcurrentUsers}
• Max Concurrent Downloads: ${ADVANCED_CONFIG.maxConcurrentDownloads}
• Max Concurrent Uploads: ${ADVANCED_CONFIG.maxConcurrentUploads}
• Connection Pool Size: ${ADVANCED_CONFIG.connectionPoolSize}

⚡ Mulai dengan mengirim link TikTok!
    `;
    
    // Process start command asynchronously
    setImmediate(async () => {
        try {
            await ctx.reply(welcomeMessage, { parse_mode: "Markdown" });
            log(`New user started bot: ${ctx.from.username || ctx.from.first_name} (${ctx.from.id})`, 'INFO', 'cyan', ctx.from.id);
        } catch (error) {
            logError(error, 'start command', ctx.from.id);
        }
    });
});

bot.command("stats", async (ctx) => {
    setImmediate(async () => {
        try {
            const uptime = process.uptime();
            const uptimeString = new Date(uptime * 1000).toISOString().substr(11, 8);
            const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            const activeUsers = resourceManager.getActiveUsersCount();
            
            const statsMessage = `
📊 *Statistik Bot Advanced*

⏱️ *Uptime:* ${uptimeString}
🧠 *Memory Usage:* ${memUsage} MB
📈 *Node.js Version:* ${process.version}
🤖 *Bot Status:* Online ✅
👥 *Active Users:* ${activeUsers}/${ADVANCED_CONFIG.maxConcurrentUsers}
🍪 *Cookie Support:* ${cookieString ? '🍪 Enabled' : '❌ Disabled'}

🚀 *Performance Metrics:*
• Concurrent Processing: **ENABLED** ⚡
• Resource Management: **ACTIVE** 🔧
• Connection Pooling: **${ADVANCED_CONFIG.connectionPoolSize} connections** 🌐
• Download Slots: **${ADVANCED_CONFIG.maxConcurrentDownloads}** 📥
• Upload Slots: **${ADVANCED_CONFIG.maxConcurrentUploads}** 📤

📊 *Current Load:*
• Active Users: ${activeUsers}
• Memory Usage: ${memUsage}MB / ${Math.round(ADVANCED_CONFIG.memoryThreshold / 1024 / 1024)}MB
• Status: ${memUsage < 512 ? '🟢 Light' : memUsage < 768 ? '🟡 Medium' : '🔴 Heavy'}
            `;
            
            await ctx.reply(statsMessage, { parse_mode: "Markdown" });
        } catch (error) {
            logError(error, 'stats command', ctx.from.id);
        }
    });
});

// Handle text messages with full concurrency - NO QUEUING
bot.on("message:text", async (ctx) => {
    // Process immediately without waiting - TRUE CONCURRENCY
    setImmediate(async () => {
        try {
            const text = ctx.message.text;
            const urls = extractUrls(text);
            
            if (urls.length === 0) {
                await ctx.reply("🔍 Kirim link TikTok untuk mengunduh video atau gambar!\n\nContoh: https://vt.tiktok.com/xxx");
                return;
            }
            
            const userId = ctx.from.id;
            log(`Processing ${urls.length} URLs simultaneously from user ${ctx.from.username || ctx.from.first_name}`, 'INFO', 'cyan', userId);
            
            // Process ALL URLs in TRUE PARALLEL - NO QUEUING
            const processingPromises = urls.map(url => {
                // Each URL gets its own execution context
                return new Promise(async (resolve) => {
                    try {
                        await processTikTokUrl(ctx, url);
                        resolve({ success: true, url });
                    } catch (error) {
                        logError(error, `process URL ${url}`, userId);
                        resolve({ success: false, url, error: error.message });
                    }
                });
            });
            
            // Execute all processing simultaneously
            const results = await Promise.allSettled(processingPromises);
            
            // Log batch results
            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.filter(r => r.status === 'fulfilled' && !r.value.success).length;
            
            log(`Batch processing complete: ${successful} successful, ${failed} failed out of ${urls.length} URLs`, 'INFO', 'green', userId);
            
            if (failed > 0 && urls.length > 1) {
                await ctx.reply(`⚠️ ${failed} dari ${urls.length} link gagal diproses. Silakan coba link yang gagal secara individual.`);
            }
            
        } catch (error) {
            logError(error, 'message handler', ctx.from?.id);
        }
    });
});

// Enhanced error handling
bot.catch((err) => {
    logError(err.error, 'Bot error handler');
    
    if (err.ctx && err.ctx.reply) {
        setImmediate(async () => {
            try {
                await err.ctx.reply("❌ Terjadi kesalahan internal. Silakan coba lagi.");
            } catch (replyError) {
                logError(replyError, 'Error reply failed');
            }
        });
    }
});

// Process monitoring with enhanced logging
process.on('uncaughtException', (error) => {
    logError(error, 'Uncaught Exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR', 'red');
});

// Graceful shutdown with resource cleanup
process.on('SIGINT', () => {
    log('Bot stopping...', 'INFO', 'yellow');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('Bot stopping...', 'INFO', 'yellow');
    bot.stop();
    process.exit(0);
});

// Start bot with advanced configuration
async function startBot() {
    try {
        log('Starting TikTok Downloader Bot - Advanced Concurrent Version...', 'INFO', 'blue');
        
        // Load cookies
        loadCookies();
        
        // Create temp directory
        if (!fs.existsSync('./temp')) {
            fs.mkdirSync('./temp');
        }
        
        // Start bot
        await bot.start();
        log('✅ Bot started successfully with advanced concurrency!', 'INFO', 'green');
        log(`Bot username: @${bot.botInfo.username}`, 'INFO', 'cyan');
        
        // Log configuration
        log('🚀 Advanced Configuration:', 'INFO', 'magenta');
        log(`   - Max Concurrent Users: ${ADVANCED_CONFIG.maxConcurrentUsers}`, 'INFO', 'green');
        log(`   - Max Concurrent Downloads: ${ADVANCED_CONFIG.maxConcurrentDownloads}`, 'INFO', 'green');
        log(`   - Max Concurrent Uploads: ${ADVANCED_CONFIG.maxConcurrentUploads}`, 'INFO', 'green');
        log(`   - Connection Pool Size: ${ADVANCED_CONFIG.connectionPoolSize}`, 'INFO', 'green');
        log(`   - Download Timeout: ${ADVANCED_CONFIG.downloadTimeout}ms`, 'INFO', 'blue');
        log(`   - Upload Timeout: ${ADVANCED_CONFIG.uploadTimeout}ms`, 'INFO', 'blue');
        log(`   - Memory Threshold: ${Math.round(ADVANCED_CONFIG.memoryThreshold / 1024 / 1024)}MB`, 'INFO', 'blue');
        
        if (cookieString) {
            log('🍪 Bot is ready with cookie support for enhanced downloads', 'INFO', 'green');
        } else {
            log('⚠️ Bot is ready without cookies (some videos might fail to download)', 'INFO', 'yellow');
        }
        
        log('🔥 TRUE CONCURRENT PROCESSING ENABLED - Multiple users will be handled simultaneously!', 'INFO', 'magenta');
        
    } catch (error) {
        logError(error, 'Bot startup');
        process.exit(1);
    }
}

// Start the bot
startBot();

module.exports = { bot, resourceManager, ADVANCED_CONFIG };
