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

// Enhanced download file function with cookie support
async function downloadFile(url, filename, retries = 3, useCookies = false) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            log(`Download attempt ${attempt}/${retries} for: ${path.basename(filename)} ${useCookies ? '(with cookies)' : ''}`, 'INFO', 'blue');
            
            const config = getAxiosConfig(useCookies);
            const response = await axios({
                ...config,
                method: 'GET',
                url: url,
                responseType: 'stream'
            });
            
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
            log(`Download attempt ${attempt} failed: ${error.message}`, 'WARN', 'yellow');
            
            // Clean up failed download
            if (fs.existsSync(filename)) {
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
    
    throw new Error(`Failed to download after ${retries} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
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

// Main TikTok processing function with auto-delete support
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

// Handle video content with enhanced error handling and cookie support
async function handleVideo(ctx, data, statusMessage, apiVersion = 'v1') {
    let filename = null;
    
    try {
        const videoUrl = getBestVideoUrl(data, apiVersion);
        if (!videoUrl) {
            throw new Error("No video URL found in response data");
        }
        
        log(`Attempting to download video from ${apiVersion.toUpperCase()} API: ${videoUrl.substring(0, 150)}...`, 'INFO', 'blue');
        
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
        
        // Generate unique filename
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substring(2, 15);
        filename = path.join(tempDir, `video_${timestamp}_${randomId}.mp4`);
        
        // Download video with automatic cookie retry
        const downloadResult = await downloadFile(videoUrl, filename);
        
        // Verify file exists and has content
        if (downloadResult.size === 0) {
            throw new Error("Downloaded file is empty");
        }
        
        if (downloadResult.size < 1024) { // Less than 1KB, probably an error page
            throw new Error("Downloaded file is too small, likely an error response");
        }
        
        log(`Video downloaded successfully: ${path.basename(filename)} (${downloadResult.sizeMB} MB)`, 'INFO', 'green');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            "📤 Mengirim video..."
        );
        
        // Generate caption with file size and API version
        const caption = generateCaption(data, false, downloadResult.sizeMB, apiVersion);
        
        // Send video with error handling
        try {
            await ctx.replyWithVideo(new InputFile(filename), {
                caption: caption,
                supports_streaming: true,
                parse_mode: "Markdown"
            });
        } catch (sendError) {
            // Try sending without parse_mode if Markdown fails
            log(`Failed to send with Markdown, trying without: ${sendError.message}`, 'WARN', 'yellow');
            try {
                await ctx.replyWithVideo(new InputFile(filename), {
                    caption: caption,
                    supports_streaming: true
                });
            } catch (sendError2) {
                // Try sending without caption if that fails too
                log(`Failed to send with caption, trying without: ${sendError2.message}`, 'WARN', 'yellow');
                await ctx.replyWithVideo(new InputFile(filename), {
                    supports_streaming: true
                });
                // Send caption separately
                await ctx.reply(caption, { parse_mode: "Markdown" });
            }
        }
        
        log(`Video sent successfully using ${apiVersion.toUpperCase()} API`, 'INFO', 'green');
        return true; // Success
        
    } catch (error) {
        logError(error, 'handleVideo');
        
        // Try to provide more specific error messages
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
        // Cleanup
        if (filename && fs.existsSync(filename)) {
            fs.unlink(filename, (err) => {
                if (err) logError(err, 'cleanup video file');
                else log(`Cleaned up temporary file: ${path.basename(filename)}`, 'INFO', 'blue');
            });
        }
    }
}

// Handle image slideshow content with enhanced error handling and size info
async function handleImageSlideshow(ctx, data, statusMessage, apiVersion = 'v1') {
    const filenames = [];
    const downloadResults = [];
    
    try {
        const images = data.images || [];
        if (images.length === 0) {
            throw new Error("No images found in slideshow data");
        }
        
        log(`Processing ${images.length} images from slideshow using ${apiVersion.toUpperCase()} API`, 'INFO', 'blue');
        
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
        
        // Download images with better error handling
        const timestamp = Date.now();
        const downloadPromises = images.map(async (imageUrl, index) => {
            try {
                const randomId = Math.random().toString(36).substring(2, 8);
                const filename = path.join(tempDir, `image_${timestamp}_${index}_${randomId}.jpg`);
                
                log(`Downloading image ${index + 1}/${images.length}`, 'INFO', 'cyan');
                const result = await downloadFile(imageUrl, filename);
                
                // Verify image file
                if (result.size < 1024) { // Less than 1KB
                    throw new Error(`Image ${index + 1} is too small (${result.size} bytes)`);
                }
                
                return { filename: result.filename, size: result.size, sizeMB: result.sizeMB };
            } catch (error) {
                logError(error, `download image ${index + 1}`);
                throw new Error(`Failed to download image ${index + 1}: ${error.message}`);
            }
        });
        
        // Download all images
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
            log(`Warning: ${failedDownloads.length} images failed to download`, 'WARN', 'yellow');
            failedDownloads.forEach(failed => {
                log(`Image ${failed.index}: ${failed.error}`, 'WARN', 'yellow');
            });
        }
        
        // Calculate total size
        const totalSizeMB = downloadResults.reduce((sum, result) => sum + parseFloat(result.sizeMB), 0).toFixed(2);
        
        log(`Successfully downloaded ${successfulDownloads.length}/${images.length} images (${totalSizeMB} MB total) using ${apiVersion.toUpperCase()} API`, 'INFO', 'green');
        
        // Update status
        await ctx.api.editMessageText(
            statusMessage.chat.id,
            statusMessage.message_id,
            `📤 Mengirim ${successfulDownloads.length} gambar...`
        );
        
        // Generate caption with total size and API version
        const caption = generateCaption(data, true, totalSizeMB, apiVersion);
        
        // Prepare media group (max 10 images for Telegram)
        const maxImages = Math.min(successfulDownloads.length, 10);
        const mediaGroup = successfulDownloads.slice(0, maxImages).map((result, index) => ({
            type: "photo",
            media: new InputFile(result.filename),
            caption: index === 0 ? caption : undefined
        }));
        
        // Send media group with error handling
        try {
            await ctx.replyWithMediaGroup(mediaGroup, { parse_mode: "Markdown" });
        } catch (sendError) {
            log(`Failed to send media group with Markdown, trying without: ${sendError.message}`, 'WARN', 'yellow');
            try {
                await ctx.replyWithMediaGroup(mediaGroup);
            } catch (sendError2) {
                log(`Failed to send media group, trying individual images: ${sendError2.message}`, 'WARN', 'yellow');
                
                // Fallback: send images individually
                for (let i = 0; i < Math.min(successfulDownloads.length, 5); i++) {
                    const result = successfulDownloads[i];
                    try {
                        await ctx.replyWithPhoto(new InputFile(result.filename), {
                            caption: i === 0 ? caption : undefined,
                            parse_mode: i === 0 ? "Markdown" : undefined
                        });
                        await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
                    } catch (individualError) {
                        logError(individualError, `send individual image ${i + 1}`);
                    }
                }
            }
        }
        
        // Warn if some images were skipped
        if (failedDownloads.length > 0) {
            await ctx.reply(
                `⚠️ ${failedDownloads.length} gambar gagal diunduh dari total ${images.length} gambar.`
            );
        }
        
        if (successfulDownloads.length > 10) {
            await ctx.reply(
                `📝 Hanya 10 gambar pertama yang dikirim (dari total ${successfulDownloads.length} gambar yang berhasil diunduh).`
            );
        }
        
        log(`Image slideshow sent successfully (${successfulDownloads.length} images, ${totalSizeMB} MB total) using ${apiVersion.toUpperCase()} API`, 'INFO', 'green');
        return true; // Success
        
    } catch (error) {
        logError(error, 'handleImageSlideshow');
        throw error;
    } finally {
        // Cleanup all files
        filenames.forEach(filename => {
            if (fs.existsSync(filename)) {
                fs.unlink(filename, (err) => {
                    if (err) logError(err, 'cleanup image file');
                    else log(`Cleaned up temporary file: ${path.basename(filename)}`, 'INFO', 'blue');
                });
            }
        });
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

🔧 *Fitur API:*
• API v1 dengan fallback ke v2 jika gagal
• Retry otomatis untuk meningkatkan success rate

🗑️ *Fitur Auto-Delete:*
• Pesan link TikTok di grup akan dihapus otomatis
• Pesan status/loading juga akan dihapus
• Fitur ini hanya bekerja jika bot memiliki permission

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

📱 *Cara Pakai:*
1. Copy link TikTok
2. Kirim ke bot
3. Tunggu proses download
4. Terima file hasil download
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

❓ *Troubleshooting:*
• Pastikan link TikTok valid
• Bot akan otomatis coba API v2 jika v1 gagal
• Beberapa video mungkin memiliki batasan region
• Bot perlu permission delete_messages untuk auto-delete
• Hubungi admin jika ada masalah

📧 *Perintah:*
/start - Mulai menggunakan bot
/help - Tampilkan bantuan ini
/stats - Statistik bot
/settings - Pengaturan auto-delete
/apiconfig - Konfigurasi API
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
    `;
    
    await ctx.reply(statsMessage, { parse_mode: "Markdown" });
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

💡 *Keunggulan:*
• Meningkatkan success rate download
• Otomatis handle API failures
• Lebih stabil dan reliable

🔍 *Format Response v2:*
• Video URL di: \`result.video.playAddr[0]\`
• Support format response yang berbeda
• Kompatibel dengan perubahan TikTok API
    `;
    
    await ctx.reply(apiConfigMessage, { parse_mode: "Markdown" });
});

// Handle text messages (look for TikTok URLs)
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const urls = extractUrls(text);
    
    if (urls.length === 0) {
        await ctx.reply("🔍 Kirim link TikTok untuk mengunduh video atau gambar!\n\nContoh: https://vt.tiktok.com/xxx");
        return;
    }
    
    // Process each URL (but limit to prevent spam)
    const maxUrls = 3;
    const urlsToProcess = urls.slice(0, maxUrls);
    
    if (urls.length > maxUrls) {
        await ctx.reply(`⚠️ Maksimal ${maxUrls} link per pesan. Memproses ${maxUrls} link pertama.`);
    }
    
    for (const url of urlsToProcess) {
        await processTikTokUrl(ctx, url);
        
        // Small delay between processing multiple URLs
        if (urlsToProcess.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
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
        log('Starting TikTok Downloader Bot...', 'INFO', 'blue');
        
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
        
    } catch (error) {
        logError(error, 'Bot startup');
        process.exit(1);
    }
}

// Start the bot
startBot();

module.exports = { bot, AUTO_DELETE_CONFIG, API_CONFIG };
