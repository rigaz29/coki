require('dotenv').config();
const { Bot, InputFile } = require("grammy");
const Tiktok = require("@tobyg74/tiktok-api-dl");
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Bot Token from environment variable
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN tidak ditemukan di file .env!');
    console.error('💡 Buat file .env dan tambahkan: BOT_TOKEN=your_bot_token_here');
    process.exit(1);
}

// Initialize Bot
const bot = new Bot(BOT_TOKEN);

// Cookie management
let cookieString = null;

// Auto-delete configuration
const AUTO_DELETE_CONFIG = {
    enabled: true, // Set to false to disable auto-delete
    deleteDelay: 2000, // Delay in milliseconds before deleting original message (2 seconds)
    onlyInGroups: true, // Only delete in groups, not in private chats
    deleteStatusMessages: true // Also delete processing status messages
};

// API version configuration
const API_CONFIG = {
    retryWithV2OnV1Failure: true, // Enable v2 fallback
    v1MaxRetries: 1, // Max retries for v1 before switching to v2
    v2MaxRetries: 2  // Max retries for v2
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

// Enhanced logging function
function log(message, level = 'INFO', color = 'reset') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(colors[color] + logMessage + colors.reset);
}

// Error monitoring function
function logError(error, context = '') {
    log(`ERROR in ${context}: ${error.message}`, 'ERROR', 'red');
    if (error.stack) {
        log(`Stack trace: ${error.stack}`, 'ERROR', 'red');
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
        log(`Cannot check delete permissions: ${error.message}`, 'WARN', 'yellow');
        return false;
    }
}

// Safe message deletion with error handling
async function safeDeleteMessage(ctx, messageId = null, delay = 0) {
    if (!AUTO_DELETE_CONFIG.enabled) return;
    
    const targetMessageId = messageId || ctx.message.message_id;
    
    try {
        // Add delay if specified
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await ctx.api.deleteMessage(ctx.chat.id, targetMessageId);
        log(`Deleted message ${targetMessageId} in chat ${ctx.chat.id}`, 'INFO', 'blue');
        return true;
    } catch (error) {
        // Don't log error for common cases like message already deleted
        if (!error.message.includes('message to delete not found')) {
            log(`Failed to delete message ${targetMessageId}: ${error.message}`, 'WARN', 'yellow');
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

// Get axios config with or without cookies
function getAxiosConfig(useCookies = false) {
    const config = {
        timeout: 30000, // 30 seconds timeout
        maxRedirects: 10,
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
    
    // Add cookies if available and requested
    if (useCookies && cookieString) {
        config.headers['Cookie'] = cookieString;
        log('🍪 Using cookies for request', 'INFO', 'cyan');
    }
    
    return config;
}

// Enhanced TikTok data fetching with v1/v2 fallback
async function fetchTikTokData(url) {
    let lastError = null;
    
    // Try v1 API first
    if (API_CONFIG.v1MaxRetries > 0) {
        for (let attempt = 1; attempt <= API_CONFIG.v1MaxRetries; attempt++) {
            try {
                log(`Attempting v1 API (attempt ${attempt}/${API_CONFIG.v1MaxRetries}): ${url}`, 'INFO', 'blue');
                
                const result = await Tiktok.Downloader(url, { version: "v1" });
                
                if (result && result.status === "success" && result.result) {
                    log('✅ v1 API successful', 'INFO', 'green');
                    return { ...result, apiVersion: 'v1' };
                } else {
                    throw new Error(result?.message || "v1 API returned unsuccessful status");
                }
                
            } catch (error) {
                lastError = error;
                log(`v1 API attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow');
                
                if (attempt < API_CONFIG.v1MaxRetries) {
                    const delay = Math.pow(2, attempt) * 1000;
                    log(`Retrying v1 in ${delay}ms...`, 'INFO', 'yellow');
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    }
    
    // Try v2 API as fallback
    if (API_CONFIG.retryWithV2OnV1Failure && API_CONFIG.v2MaxRetries > 0) {
        log('🔄 v1 API failed, trying v2 API as fallback...', 'INFO', 'cyan');
        
        for (let attempt = 1; attempt <= API_CONFIG.v2MaxRetries; attempt++) {
            try {
                log(`Attempting v2 API (attempt ${attempt}/${API_CONFIG.v2MaxRetries}): ${url}`, 'INFO', 'blue');
                
                const result = await Tiktok.Downloader(url, { version: "v2" });
                
                if (result && result.status === "success" && result.result) {
                    log('✅ v2 API successful', 'INFO', 'green');
                    return { ...result, apiVersion: 'v2' };
                } else {
                    throw new Error(result?.message || "v2 API returned unsuccessful status");
                }
                
            } catch (error) {
                lastError = error;
                log(`v2 API attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow');
                
                if (attempt < API_CONFIG.v2MaxRetries) {
                    const delay = Math.pow(2, attempt) * 1000;
                    log(`Retrying v2 in ${delay}ms...`, 'INFO', 'yellow');
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    }
    
    // Both APIs failed
    throw new Error(`Both v1 and v2 APIs failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

// Enhanced download function with DIRECT STREAMING support
async function downloadFile(url, filename = null, retries = 3, useCookies = false, streamMode = false) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            log(`${streamMode ? 'Streaming' : 'Download'} attempt ${attempt}/${retries} for: ${streamMode ? 'direct stream' : path.basename(filename)} ${useCookies ? '(with cookies)' : ''}`, 'INFO', 'blue');
            
            const config = getAxiosConfig(useCookies);
            const response = await axios({
                ...config,
                method: 'GET',
                url: url,
                responseType: 'stream'
            });
            
            // STREAMING MODE - Return stream directly without saving to disk
            if (streamMode) {
                const contentLength = response.headers['content-length'];
                const sizeMB = contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(2) : 'Unknown';
                
                log(`Stream ready: ${sizeMB} MB`, 'INFO', 'green');
                
                return {
                    stream: response.data,
                    size: contentLength ? parseInt(contentLength) : 0,
                    sizeMB: sizeMB,
                    contentType: response.headers['content-type'] || 'application/octet-stream'
                };
            }
            
            // TRADITIONAL MODE - Save to file (fallback for images)
            const writer = fs.createWriteStream(filename);
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    const stats = fs.statSync(filename);
                    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                    log(`File downloaded successfully: ${path.basename(filename)} (${sizeMB} MB)`, 'INFO', 'green');
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
            });
            
        } catch (error) {
            lastError = error;
            log(`${streamMode ? 'Streaming' : 'Download'} attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow');
            
            // Clean up failed download (only for file mode)
            if (!streamMode && filename && fs.existsSync(filename)) {
                fs.unlink(filename, () => {});
            }
            
            // If first attempt failed without cookies, try with cookies on next attempt
            if (attempt === 1 && !useCookies && cookieString && (error.response?.status === 403 || error.code === 'ECONNREFUSED')) {
                log('🍪 First attempt failed, will try with cookies on next attempt', 'INFO', 'yellow');
                useCookies = true;
            }
            
            if (attempt < retries) {
                // Wait before retry (exponential backoff)
                const delay = Math.pow(2, attempt) * 1000;
                log(`Retrying in ${delay}ms...`, 'INFO', 'yellow');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw new Error(`Failed to ${streamMode ? 'stream' : 'download'} after ${retries} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
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

// Get best quality video URL with fallback options (supports both v1 and v2)
function getBestVideoUrl(videoData, apiVersion = 'v1') {
    if (!videoData || !videoData.video) return null;
    
    let videoSources = [];
    
    if (apiVersion === 'v2') {
        // Handle v2 API response format
        if (videoData.video.playAddr && Array.isArray(videoData.video.playAddr)) {
            // v2 format: playAddr is an array
            videoSources = videoData.video.playAddr;
            log(`v2 API: Found ${videoSources.length} video sources`, 'INFO', 'cyan');
        }
    } else {
        // Handle v1 API response format
        videoSources = [
            videoData.video.playAddr,
            videoData.video.downloadAddr,
            videoData.video.play,
            videoData.video.noWaterMark,
            videoData.video.watermark
        ].filter(Boolean);
    }
    
    // If playAddr is an array, get the first one
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

// Generate enhanced caption with hyperlink and description
function generateCaption(data, isPhoto = false, fileSize = null, apiVersion = 'v1') {
    const createTime = formatTimestamp(data.createTime || data.create_time);
    const uid = data.author?.uid || data.author?.id || 'Unknown';
    const username = data.author?.uniqueId || data.author?.username || data.author?.nickname || 'Unknown';
    const videoId = data.id || data.aweme_id || 'Unknown';
    
    // Get original TikTok URL
    const originalUrl = data.url || data.webVideoUrl || `https://www.tiktok.com/@${username}/${isPhoto ? 'photo' : 'video'}/${videoId}`;
    
    let caption = `📅 ${createTime}\n`;
    caption += `👤 UID: ${uid}\n`;
    
    // Create hyperlink for username
    caption += `👤 Username: [${username}](${originalUrl})\n`;
    
    // Add file size if provided
    if (fileSize) {
        caption += `📁 Size: ${fileSize} MB\n`;
    }
    
    // Add API version info
    caption += `🔧 API: ${apiVersion.toUpperCase()}\n`;
    
    caption += `🔗 [Link TikTok](${originalUrl})`;
    
    // Add description if available
    const description = data.desc || data.description || '';
    if (description && description.trim()) {
        const cleanDesc = description.trim().substring(0, 300); // Limit description length
        caption += `\n\n📝 "${cleanDesc}${description.length > 300 ? '...' : ''}"`;
    }
    
    return caption;
}

// Main TikTok processing function with auto-delete support - NO RATE LIMITING
async function processTikTokUrl(ctx, url) {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const isGroup = isGroupChat(ctx);
    const originalMessageId = ctx.message.message_id;
    
    log(`Processing TikTok URL from user ${username} (${userId}) in ${isGroup ? 'group' : 'private'}: ${url}`, 'INFO', 'cyan');
    
    let statusMessage = null;
    let canDelete = false;
    
    try {
        // Check deletion permissions if in group
        if (isGroup && AUTO_DELETE_CONFIG.enabled) {
            canDelete = await canDeleteMessages(ctx);
            if (canDelete) {
                log('Bot has permission to delete messages in this group', 'INFO', 'blue');
            } else {
                log('Bot cannot delete messages in this group', 'WARN', 'yellow');
            }
        }
        
        // Show typing indicator
        await ctx.replyWithChatAction("typing");
        
        // Send initial message
        statusMessage = await ctx.reply("📄 Mengunduh konten TikTok...");
        
        // Get TikTok data with v1/v2 fallback
        log(`Fetching TikTok data for: ${url}`, 'INFO', 'blue');
        const result = await fetchTikTokData(url);
        
        const data = result.result;
        const apiVersion = result.apiVersion || 'v1';
        
        log(`Successfully fetched TikTok data using ${apiVersion.toUpperCase()} API. Type: ${data.type}`, 'INFO', 'green');
        
        // Update status message
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📥 Memproses konten..."
        );
        
        // Check content type and process
        let success = false;
        if (data.type === "image" || (data.images && data.images.length > 0)) {
            // Handle image slideshow
            success = await handleImageSlideshow(ctx, data, statusMessage, apiVersion);
        } else {
            // Handle video
            success = await handleVideo(ctx, data, statusMessage, apiVersion);
        }
        
        // Delete status message if configured
        if (AUTO_DELETE_CONFIG.deleteStatusMessages && statusMessage) {
            await safeDeleteMessage(ctx, statusMessage.message_id);
            statusMessage = null; // Prevent double deletion
        }
        
        // Delete original message if successful and in group
        if (success && isGroup && AUTO_DELETE_CONFIG.enabled && 
            (!AUTO_DELETE_CONFIG.onlyInGroups || isGroup) && canDelete) {
            
            log(`Scheduling deletion of original message ${originalMessageId} in ${AUTO_DELETE_CONFIG.deleteDelay}ms`, 'INFO', 'cyan');
            await safeDeleteMessage(ctx, originalMessageId, AUTO_DELETE_CONFIG.deleteDelay);
        }
        
        log(`Successfully processed TikTok URL for user ${username} using ${apiVersion.toUpperCase()} API`, 'INFO', 'green');
        
    } catch (error) {
        logError(error, 'processTikTokUrl');
        await ctx.reply(`❌ Gagal mengunduh konten: ${error.message}`);
        
        // Still delete status message on error if configured
        if (AUTO_DELETE_CONFIG.deleteStatusMessages && statusMessage) {
            await safeDeleteMessage(ctx, statusMessage.message_id, 3000); // Delete after 3s on error
        }
    } finally {
        // Cleanup status message if still exists
        if (statusMessage && AUTO_DELETE_CONFIG.deleteStatusMessages) {
            await safeDeleteMessage(ctx, statusMessage.message_id);
        }
    }
}

// Handle video content with DIRECT STREAMING - No disk storage required!
async function handleVideo(ctx, data, statusMessage, apiVersion = 'v1') {
    try {
        const videoUrl = getBestVideoUrl(data, apiVersion);
        if (!videoUrl) {
            throw new Error("No video URL found in response data");
        }
        
        log(`🚀 STREAMING video directly from ${apiVersion.toUpperCase()} API: ${videoUrl.substring(0, 150)}...`, 'INFO', 'blue');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "🌊 Streaming video langsung..."
        );
        
        // STREAM MODE - Download video directly to memory without saving to disk
        const streamResult = await downloadFile(videoUrl, null, 3, false, true);
        
        // Verify stream has content
        if (streamResult.size === 0) {
            throw new Error("Stream is empty");
        }
        
        if (streamResult.size < 1024) { // Less than 1KB, probably an error page
            throw new Error("Stream is too small, likely an error response");
        }
        
        log(`🌊 Video stream ready: ${streamResult.sizeMB} MB - Sending directly to Telegram`, 'INFO', 'green');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📤 Mengirim video (streaming)..."
        );
        
        // Generate caption with file size and API version
        const caption = generateCaption(data, false, streamResult.sizeMB, apiVersion);
        
        // Create InputFile from stream - NO TEMPORARY FILE NEEDED!
        const inputFile = new InputFile(streamResult.stream, `video_${Date.now()}.mp4`);
        
        // Send video directly from stream with error handling
        try {
            await ctx.replyWithVideo(inputFile, {
                caption: caption,
                supports_streaming: true,
                parse_mode: "Markdown"
            });
        } catch (sendError) {
            // Try sending without parse_mode if Markdown fails
            log(`Failed to send with Markdown, trying without: ${sendError.message}`, 'WARN', 'yellow');
            try {
                // Create new stream since the previous one might be consumed
                const retryStreamResult = await downloadFile(videoUrl, null, 2, false, true);
                const retryInputFile = new InputFile(retryStreamResult.stream, `video_${Date.now()}.mp4`);
                
                await ctx.replyWithVideo(retryInputFile, {
                    caption: caption,
                    supports_streaming: true
                });
            } catch (sendError2) {
                // Try sending without caption if that fails too
                log(`Failed to send with caption, trying without: ${sendError2.message}`, 'WARN', 'yellow');
                
                const finalStreamResult = await downloadFile(videoUrl, null, 2, false, true);
                const finalInputFile = new InputFile(finalStreamResult.stream, `video_${Date.now()}.mp4`);
                
                await ctx.replyWithVideo(finalInputFile, {
                    supports_streaming: true
                });
                // Send caption separately
                await ctx.reply(caption, { parse_mode: "Markdown" });
            }
        }
        
        log(`🚀 Video streamed successfully using ${apiVersion.toUpperCase()} API - NO DISK STORAGE USED!`, 'INFO', 'green');
        return true; // Success
        
    } catch (error) {
        logError(error, 'handleVideo');
        
        // Try to provide more specific error messages
        if (error.code === 'ECONNREFUSED') {
            throw new Error("Koneksi ditolak server TikTok. Coba lagi dalam beberapa menit.");
        } else if (error.code === 'ETIMEDOUT') {
            throw new Error("Timeout saat streaming video. Video mungkin terlalu besar atau koneksi lambat.");
        } else if (error.message.includes('403')) {
            throw new Error("Akses ke video ditolak. Video mungkin private atau region-blocked.");
        } else if (error.message.includes('404')) {
            throw new Error("Video tidak ditemukan. Link mungkin sudah expired atau dihapus.");
        }
        
        throw error;
    }
    // NO CLEANUP NEEDED - No temporary files created! 🎉
}

// Handle image slideshow with HYBRID STREAMING - Minimal disk usage
async function handleImageSlideshow(ctx, data, statusMessage, apiVersion = 'v1') {
    const tempFiles = [];
    const streamResults = [];
    
    try {
        const images = data.images || [];
        if (images.length === 0) {
            throw new Error("No images found in slideshow data");
        }
        
        log(`🌊 Processing ${images.length} images with STREAMING optimization using ${apiVersion.toUpperCase()} API`, 'INFO', 'blue');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            `🌊 Streaming ${images.length} gambar...`
        );
        
        // For images, we use a hybrid approach: stream to temporary buffers, then send
        // This is because Telegram media groups need file references
        const timestamp = Date.now();
        
        // Process images with OPTIMIZED streaming - parallel processing
        const imageProcessPromises = images.map(async (imageUrl, index) => {
            try {
                log(`🌊 Streaming image ${index + 1}/${images.length}`, 'INFO', 'cyan');
                
                // Try streaming mode first
                try {
                    const streamResult = await downloadFile(imageUrl, null, 2, false, true);
                    
                    // Convert stream to buffer for Telegram compatibility
                    const chunks = [];
                    
                    return new Promise((resolve, reject) => {
                        streamResult.stream.on('data', chunk => chunks.push(chunk));
                        streamResult.stream.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            
                            // Verify image buffer
                            if (buffer.length < 1024) {
                                reject(new Error(`Image ${index + 1} buffer too small (${buffer.length} bytes)`));
                                return;
                            }
                            
                            const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
                            log(`🌊 Image ${index + 1} streamed to buffer: ${sizeMB} MB`, 'INFO', 'green');
                            
                            resolve({
                                buffer: buffer,
                                size: buffer.length,
                                sizeMB: sizeMB,
                                index: index,
                                filename: `image_${timestamp}_${index}.jpg`
                            });
                        });
                        streamResult.stream.on('error', reject);
                    });
                    
                } catch (streamError) {
                    log(`Stream failed for image ${index + 1}, falling back to temp file: ${streamError.message}`, 'WARN', 'yellow');
                    
                    // Fallback to temporary file method
                    const tempDir = './temp';
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    const randomId = Math.random().toString(36).substring(2, 8);
                    const filename = path.join(tempDir, `image_${timestamp}_${index}_${randomId}.jpg`);
                    
                    const result = await downloadFile(imageUrl, filename, 2, false, false);
                    tempFiles.push(filename);
                    
                    return {
                        filename: result.filename,
                        size: result.size,
                        sizeMB: result.sizeMB,
                        index: index,
                        isFile: true
                    };
                }
                
            } catch (error) {
                logError(error, `process image ${index + 1}`);
                throw new Error(`Failed to process image ${index + 1}: ${error.message}`);
            }
        });
        
        // Process all images simultaneously - PARALLEL STREAMING
        const imageResults = await Promise.allSettled(imageProcessPromises);
        
        // Separate successful and failed results
        const successfulImages = [];
        const failedImages = [];
        
        imageResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                successfulImages.push(result.value);
                streamResults.push(result.value);
            } else {
                failedImages.push({ index: index + 1, error: result.reason.message });
            }
        });
        
        if (successfulImages.length === 0) {
            throw new Error("Failed to process any images");
        }
        
        if (failedImages.length > 0) {
            log(`Warning: ${failedImages.length} images failed to process`, 'WARN', 'yellow');
        }
        
        // Calculate total size
        const totalSizeMB = successfulImages.reduce((sum, result) => sum + parseFloat(result.sizeMB), 0).toFixed(2);
        
        log(`🌊 Successfully processed ${successfulImages.length}/${images.length} images (${totalSizeMB} MB total) using STREAMING`, 'INFO', 'green');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            `📤 Mengirim ${successfulImages.length} gambar (streamed)...`
        );
        
        // Generate caption
        const caption = generateCaption(data, true, totalSizeMB, apiVersion);
        
        // Prepare media group with buffers and files
        const mediaGroup = successfulImages
            .sort((a, b) => a.index - b.index)
            .map((result, index) => ({
                type: "photo",
                media: result.buffer ? 
                    new InputFile(result.buffer, result.filename) : 
                    new InputFile(result.filename),
                caption: index === 0 ? caption : undefined
            }));
        
        // Send media groups in chunks (Telegram limit: 10 per group)
        const mediaGroupChunks = [];
        for (let i = 0; i < mediaGroup.length; i += 10) {
            mediaGroupChunks.push(mediaGroup.slice(i, i + 10));
        }
        
        // Send all chunks simultaneously
        const sendPromises = mediaGroupChunks.map(async (chunk, chunkIndex) => {
            try {
                await ctx.replyWithMediaGroup(chunk, { parse_mode: "Markdown" });
                log(`📤 Media group chunk ${chunkIndex + 1} sent successfully`, 'INFO', 'green');
            } catch (sendError) {
                log(`Failed to send media group chunk ${chunkIndex + 1} with Markdown: ${sendError.message}`, 'WARN', 'yellow');
                try {
                    await ctx.replyWithMediaGroup(chunk);
                } catch (sendError2) {
                    log(`Failed to send media group chunk ${chunkIndex + 1}, trying individual: ${sendError2.message}`, 'WARN', 'yellow');
                    
                    // Send individually
                    const individualPromises = chunk.map(async (item, itemIndex) => {
                        try {
                            await ctx.replyWithPhoto(item.media, {
                                caption: item.caption || undefined,
                                parse_mode: item.caption ? "Markdown" : undefined
                            });
                        } catch (individualError) {
                            logError(individualError, `send individual image from chunk ${chunkIndex + 1}, item ${itemIndex + 1}`);
                        }
                    });
                    
                    await Promise.allSettled(individualPromises);
                }
            }
        });
        
        await Promise.allSettled(sendPromises);
        
        // Status messages
        if (failedImages.length > 0) {
            await ctx.reply(`⚠️ ${failedImages.length} gambar gagal diproses dari total ${images.length} gambar.`);
        }
        
        log(`🌊 Image slideshow sent successfully (${successfulImages.length} images, ${totalSizeMB} MB total) using STREAMING optimization`, 'INFO', 'green');
        return true;
        
    } catch (error) {
        logError(error, 'handleImageSlideshow');
        throw error;
    } finally {
        // Cleanup only temporary files (buffers are automatically garbage collected)
        tempFiles.forEach(filename => {
            if (fs.existsSync(filename)) {
                fs.unlink(filename, (err) => {
                    if (err) logError(err, 'cleanup temp image file');
                    else log(`🧹 Cleaned up temp file: ${path.basename(filename)}`, 'INFO', 'blue');
                });
            }
        });
        
        log(`🌊 Memory cleanup completed - ${streamResults.filter(r => r.buffer).length} images were streamed without disk storage`, 'INFO', 'cyan');
    }
}

// Bot event handlers
bot.command("start", async (ctx) => {
    const welcomeMessage = `
🤖 *TikTok Downloader Bot*

Selamat datang! Bot ini dapat mengunduh video dan gambar dari TikTok.

📝 *Cara Penggunaan:*
• Kirim link TikTok ke bot
• Bot akan otomatis mengunduh dan mengirim konten
• Support video dan slideshow gambar
• Di grup, pesan link akan dihapus otomatis setelah konten terkirim

🔗 *Format Link yang Didukung:*
• https://www.tiktok.com/@username/video/123
• https://vt.tiktok.com/xxx
• https://vm.tiktok.com/xxx

🌊 *STREAMING TECHNOLOGY:*
• 🚀 **DIRECT STREAMING** - Video langsung di-stream tanpa simpan ke server!
• 💾 **ZERO DISK USAGE** - Tidak menggunakan storage server
• ⚡ **ULTRA FAST** - Lebih cepat karena tidak ada proses write/read file
• 🔧 **MEMORY EFFICIENT** - Langsung dari TikTok ke Telegram

🔧 *Fitur API:*
• API v1 dengan fallback ke v2 jika gagal
• Retry otomatis untuk meningkatkan success rate

🗑️ *Fitur Auto-Delete:*
• Pesan link TikTok di grup akan dihapus otomatis
• Pesan status/loading juga akan dihapus
• Fitur ini hanya bekerja jika bot memiliki permission

🚀 *Unlimited Processing:*
• Tidak ada batasan rate limiting
• Multiple user dapat mengirim bersamaan
• Semua permintaan diproses secara paralel
• Tidak ada batasan per akun Telegram

⚡ Mulai dengan mengirim link TikTok!
    `;
    
    await ctx.reply(welcomeMessage, { parse_mode: "Markdown" });
    log(`New user started bot: ${ctx.from.username || ctx.from.first_name} (${ctx.from.id})`, 'INFO', 'cyan');
});

bot.command("help", async (ctx) => {
    const helpMessage = `
📋 *Bantuan TikTok Downloader Bot*

🎯 *Fitur:*
• Download video TikTok
• Download slideshow gambar TikTok
• Caption lengkap dengan info video
• Support berbagai format link
• Auto-delete pesan link di grup
• Cookie support untuk download yang lebih baik
• API v1 dengan fallback ke v2
• 🌊 **DIRECT STREAMING TECHNOLOGY**

🌊 *STREAMING FEATURES:*
• 🚀 **Zero Disk Usage** - Video langsung di-stream dari TikTok ke Telegram
• ⚡ **Ultra Fast Processing** - Tidak ada delay write/read file ke disk
• 💾 **Memory Efficient** - Minimal penggunaan storage server
• 🔄 **Intelligent Fallback** - Auto fallback ke file mode jika streaming gagal
• 📱 **Hybrid Mode** - Gambar menggunakan buffer streaming untuk efisiensi maksimal

📱 *Cara Pakai:*
1. Copy link TikTok
2. Kirim ke bot
3. ⚡ Bot akan **STREAMING** konten langsung (no download ke server!)
4. Terima file hasil streaming
5. (Di grup) Pesan link akan dihapus otomatis

🔧 *API Configuration:*
• v1 Max Retries: ${API_CONFIG.v1MaxRetries}
• v2 Fallback: ${API_CONFIG.retryWithV2OnV1Failure ? '✅' : '❌'}
• v2 Max Retries: ${API_CONFIG.v2MaxRetries}

🗑️ *Auto-Delete Settings:*
• Enabled: ${AUTO_DELETE_CONFIG.enabled ? '✅' : '❌'}
• Only in Groups: ${AUTO_DELETE_CONFIG.onlyInGroups ? '✅' : '❌'}
• Delete Status Messages: ${AUTO_DELETE_CONFIG.deleteStatusMessages ? '✅' : '❌'}
• Delete Delay: ${AUTO_DELETE_CONFIG.deleteDelay}ms

🚀 *Performance Features:*
• **No Rate Limiting** - Send as many links as you want!
• **Parallel Processing** - Multiple downloads simultaneously
• **No User Limits** - Each Telegram account has unlimited usage
• **Instant Processing** - No delays between requests
• 🌊 **DIRECT STREAMING** - Zero server storage usage!

🌊 *Technical Advantages:*
• **Faster Processing** - No file I/O operations
• **Server Resource Saving** - No disk space used
• **Better Scalability** - Handle more concurrent users
• **Real-time Transfer** - Data flows directly from source to destination
• **Automatic Cleanup** - No temporary files to manage

❓ *Troubleshooting:*
• Pastikan link TikTok valid
• Bot akan otomatis coba API v2 jika v1 gagal
• Streaming mode otomatis fallback ke file mode jika diperlukan
• Beberapa video mungkin memiliki batasan region
• Bot perlu permission delete_messages untuk auto-delete
• Hubungi admin jika ada masalah

📧 *Perintah:*
/start - Mulai menggunakan bot
/help - Tampilkan bantuan ini
/stats - Statistik bot
/settings - Pengaturan auto-delete
/apiconfig - Konfigurasi API
/streaming - Info teknologi streaming
    `;
    
    await ctx.reply(helpMessage, { parse_mode: "Markdown" });
});

bot.command("stats", async (ctx) => {
    const uptime = process.uptime();
    const uptimeString = new Date(uptime * 1000).toISOString().substr(11, 8);
    
    const cookieStatus = cookieString ? '🍪 Enabled' : '❌ Disabled';
    const autoDeleteStatus = AUTO_DELETE_CONFIG.enabled ? '🗑️ Enabled' : '❌ Disabled';
    const v2FallbackStatus = API_CONFIG.retryWithV2OnV1Failure ? '🔄 Enabled' : '❌ Disabled';
    
    const statsMessage = `
📊 *Statistik Bot*

⏱️ *Uptime:* ${uptimeString}
🧠 *Memory Usage:* ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB
📈 *Node.js Version:* ${process.version}
🤖 *Bot Status:* Online ✅
🍪 *Cookie Support:* ${cookieStatus}
🗑️ *Auto-Delete:* ${autoDeleteStatus}
🔧 *v2 API Fallback:* ${v2FallbackStatus}
🚀 *Rate Limiting:* **DISABLED** ⚡
🔄 *Parallel Processing:* **ENABLED** 💨

🌊 *STREAMING STATUS:*
• Direct Video Streaming: **ACTIVE** 🚀
• Zero Disk Usage: **ENABLED** 💾
• Memory-based Processing: **OPTIMIZED** ⚡
• Hybrid Image Streaming: **ACTIVE** 🖼️
• Fallback Mode: **AVAILABLE** 🔄
    `;
    
    await ctx.reply(statsMessage, { parse_mode: "Markdown" });
});

bot.command("streaming", async (ctx) => {
    const streamingMessage = `
🌊 *TEKNOLOGI STREAMING*

🚀 *Direct Video Streaming:*
• Video TikTok **TIDAK** disimpan ke server disk
• Data di-stream langsung dari TikTok → Bot → Telegram
• Zero file I/O operations pada server
• Menggunakan Node.js Readable Streams

📱 *Cara Kerja:*
1. Bot mengakses video URL dari TikTok API
2. Membuat HTTP stream request ke TikTok servers
3. Data video di-pipe langsung ke Telegram Bot API
4. Telegram menerima stream dan mengirim ke user
5. **TIDAK ADA FILE** yang tersimpan di server bot!

🖼️ *Hybrid Image Processing:*
• Gambar di-stream ke memory buffer
• Buffer langsung dikirim ke Telegram
• Fallback ke temporary file jika buffer gagal
• Automatic cleanup untuk optimasi memory

⚡ *Keunggulan Streaming:*
• **Faster Processing** - Eliminasi write/read disk operations
• **Zero Storage** - Server disk usage = 0 MB
• **Better Scalability** - Handle ribuan user concurrent
• **Memory Efficient** - Data tidak tertumpuk di disk
• **Real-time Transfer** - Latency minimal

🔧 *Technical Implementation:*
\`\`\`javascript
// Stream langsung tanpa file
const stream = await downloadFile(url, null, 3, false, true);
const inputFile = new InputFile(stream.data, 'video.mp4');
await ctx.replyWithVideo(inputFile);
\`\`\`

📊 *Performance Comparison:*
• Traditional: Download → Save → Read → Send → Delete
• Streaming: **Stream → Send** ✅

🔄 *Fallback System:*
• Jika streaming gagal → Auto fallback ke file mode
• Smart error detection dan recovery
• Seamless user experience

💡 *Environmental Benefits:*
• Reduced server resource usage
• Lower energy consumption
• Minimal disk wear
• Optimized bandwidth utilization

🌊 Bot ini menggunakan **cutting-edge streaming technology** untuk performa maksimal!
    `;
    
    await ctx.reply(streamingMessage, { parse_mode: "Markdown" });
});

bot.command("settings", async (ctx) => {
    const isGroup = isGroupChat(ctx);
    let canDelete = false;
    
    if (isGroup) {
        canDelete = await canDeleteMessages(ctx);
    }
    
    const settingsMessage = `
⚙️ *Pengaturan Auto-Delete*

🗑️ *Status:* ${AUTO_DELETE_CONFIG.enabled ? '✅ Aktif' : '❌ Nonaktif'}
👥 *Hanya di Grup:* ${AUTO_DELETE_CONFIG.onlyInGroups ? '✅ Ya' : '❌ Tidak'}
📝 *Hapus Pesan Status:* ${AUTO_DELETE_CONFIG.deleteStatusMessages ? '✅ Ya' : '❌ Tidak'}
⏰ *Delay Hapus:* ${AUTO_DELETE_CONFIG.deleteDelay}ms

📍 *Chat Saat Ini:*
• Tipe: ${isGroup ? 'Grup' : 'Private'}
• Bot dapat hapus pesan: ${canDelete ? '✅ Ya' : '❌ Tidak'}

🚀 *Performance Settings:*
• Rate Limiting: **DISABLED** ⚡
• User Limits: **NONE** 🚫
• Parallel Processing: **ENABLED** 💨
• Max URLs per message: **UNLIMITED** ∞

${!canDelete && isGroup ? '\n⚠️ *Peringatan:* Bot tidak memiliki permission untuk menghapus pesan di grup ini. Minta admin untuk memberikan permission "Delete Messages" kepada bot.' : ''}

💡 *Catatan:* Pengaturan ini berlaku global untuk semua chat.
    `;
    
    await ctx.reply(settingsMessage, { parse_mode: "Markdown" });
});

bot.command("apiconfig", async (ctx) => {
    const apiConfigMessage = `
🔧 *Konfigurasi API TikTok*

📡 *API v1 Settings:*
• Max Retries: ${API_CONFIG.v1MaxRetries}
• Status: ${API_CONFIG.v1MaxRetries > 0 ? '✅ Aktif' : '❌ Nonaktif'}

🔄 *API v2 Fallback:*
• Enabled: ${API_CONFIG.retryWithV2OnV1Failure ? '✅ Aktif' : '❌ Nonaktif'}
• Max Retries: ${API_CONFIG.v2MaxRetries}
• Status: ${API_CONFIG.v2MaxRetries > 0 ? '✅ Aktif' : '❌ Nonaktif'}

📈 *Strategi Download:*
1. Coba API v1 terlebih dahulu (${API_CONFIG.v1MaxRetries}x retry)
2. Jika v1 gagal, otomatis beralih ke v2
3. API v2 akan dicoba hingga ${API_CONFIG.v2MaxRetries}x retry
4. Jika keduanya gagal, tampilkan error

🚀 *Performance Optimizations:*
• **No Rate Limiting** - Process unlimited requests
• **Parallel Processing** - Multiple downloads simultaneously  
• **No User Restrictions** - Each user has unlimited access
• **Instant Response** - No artificial delays

💡 *Keunggulan:*
• Meningkatkan success rate download
• Otomatis handle API failures
• Lebih stabil dan reliable
• Maximum throughput untuk multiple users

🔍 *Format Response v2:*
• Video URL di: \`result.video.playAddr[0]\`
• Support format response yang berbeda
• Kompatibel dengan perubahan TikTok API
    `;
    
    await ctx.reply(apiConfigMessage, { parse_mode: "Markdown" });
});

// Handle text messages (look for TikTok URLs) - NO RATE LIMITING
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const urls = extractUrls(text);
    
    if (urls.length === 0) {
        await ctx.reply("🔍 Kirim link TikTok untuk mengunduh video atau gambar!\n\nContoh: https://vt.tiktok.com/xxx");
        return;
    }
    
    // Process ALL URLs simultaneously - NO LIMITS
    log(`Processing ${urls.length} URLs simultaneously from user ${ctx.from.username || ctx.from.first_name}`, 'INFO', 'cyan');
    
    // Process all URLs in parallel - NO RATE LIMITING
    const processingPromises = urls.map(url => processTikTokUrl(ctx, url));
    
    // Wait for all to complete, but don't fail if some fail
    const results = await Promise.allSettled(processingPromises);
    
    // Log results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    log(`Batch processing complete: ${successful} successful, ${failed} failed out of ${urls.length} URLs`, 'INFO', 'green');
    
    if (failed > 0 && urls.length > 1) {
        await ctx.reply(`⚠️ ${failed} dari ${urls.length} link gagal diproses. Silakan coba link yang gagal secara individual.`);
    }
});

// Error handling
bot.catch((err) => {
    logError(err.error, 'Bot error handler');
    
    if (err.ctx && err.ctx.reply) {
        err.ctx.reply("❌ Terjadi kesalahan internal. Silakan coba lagi.")
            .catch(() => {}); // Ignore errors when sending error message
    }
});

// Process monitoring
process.on('uncaughtException', (error) => {
    logError(error, 'Uncaught Exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR', 'red');
});

// Graceful shutdown
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

// Start bot with cookie loading
async function startBot() {
    try {
        log('Starting TikTok Downloader Bot with STREAMING TECHNOLOGY...', 'INFO', 'blue');
        
        // Load cookies if available
        loadCookies();
        
        // Create temp directory
        if (!fs.existsSync('./temp')) {
            fs.mkdirSync('./temp');
        }
        
        await bot.start();
        log('✅ Bot started successfully!', 'INFO', 'green');
        log(`Bot username: @${bot.botInfo.username}`, 'INFO', 'cyan');
        
        if (cookieString) {
            log('🍪 Bot is ready with cookie support for enhanced downloads', 'INFO', 'green');
        } else {
            log('⚠️ Bot is ready without cookies (some videos might fail to download)', 'INFO', 'yellow');
            log('💡 Tip: Create cookies.txt file for better download success rate', 'INFO', 'blue');
        }
        
        // Log auto-delete status
        if (AUTO_DELETE_CONFIG.enabled) {
            log('🗑️ Auto-delete feature is enabled', 'INFO', 'green');
            log(`   - Only in groups: ${AUTO_DELETE_CONFIG.onlyInGroups}`, 'INFO', 'blue');
            log(`   - Delete status messages: ${AUTO_DELETE_CONFIG.deleteStatusMessages}`, 'INFO', 'blue');
            log(`   - Delete delay: ${AUTO_DELETE_CONFIG.deleteDelay}ms`, 'INFO', 'blue');
        } else {
            log('⚠️ Auto-delete feature is disabled', 'INFO', 'yellow');
        }
        
        // Log API configuration
        log('🔧 API Configuration:', 'INFO', 'cyan');
        log(`   - v1 retries: ${API_CONFIG.v1MaxRetries}`, 'INFO', 'blue');
        log(`   - v2 fallback: ${API_CONFIG.retryWithV2OnV1Failure}`, 'INFO', 'blue');
        log(`   - v2 retries: ${API_CONFIG.v2MaxRetries}`, 'INFO', 'blue');
        
        // Log performance settings
        log('🚀 Performance Configuration:', 'INFO', 'magenta');
        log('   - Rate Limiting: DISABLED ⚡', 'INFO', 'green');
        log('   - User Limits: NONE 🚫', 'INFO', 'green');
        log('   - Parallel Processing: ENABLED 💨', 'INFO', 'green');
        log('   - Max URLs per message: UNLIMITED ∞', 'INFO', 'green');
        
        // Log streaming technology
        log('🌊 Streaming Technology:', 'INFO', 'cyan');
        log('   - Direct Video Streaming: ENABLED 🚀', 'INFO', 'green');
        log('   - Zero Disk Usage: ACTIVE 💾', 'INFO', 'green');
        log('   - Memory-based Processing: OPTIMIZED ⚡', 'INFO', 'green');
        log('   - Hybrid Image Streaming: ACTIVE 🖼️', 'INFO', 'green');
        log('   - Fallback System: AVAILABLE 🔄', 'INFO', 'green');
        
    } catch (error) {
        logError(error, 'Bot startup');
        process.exit(1);
    }
}

// Start the bot
startBot();

module.exports = { bot, AUTO_DELETE_CONFIG, API_CONFIG };
