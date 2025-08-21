const { Bot } = require('grammy');
const { WebcastPushConnection } = require('tiktok-live-connector');
const fs = require('fs').promises;
require('dotenv').config();

// Konfigurasi dari environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_FILE = 'monitored_users.json';
const CHECK_INTERVAL = 20000; // Check setiap 20 detik
const NOTIFICATION_INTERVAL = 180000; // Notifikasi setiap 3 menit jika masih live

// Inisialisasi bot
const bot = new Bot(BOT_TOKEN);

// Storage untuk data monitoring
let monitoredUsers = [];
let liveStatus = {}; // Track status live dan waktu notifikasi terakhir
let monitoring = false;

// Fungsi untuk load data dari file
async function loadMonitoredUsers() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        monitoredUsers = JSON.parse(data);
        console.log(`📁 Loaded ${monitoredUsers.length} monitored users`);
    } catch (error) {
        console.log('📁 No existing data file, starting fresh');
        monitoredUsers = [];
    }
}

// Fungsi untuk save data ke file
async function saveMonitoredUsers() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(monitoredUsers, null, 2));
        console.log('💾 Data saved successfully');
    } catch (error) {
        console.error('❌ Error saving data:', error.message);
    }
}

// Fungsi untuk mengecek apakah user sedang live
async function checkUserLive(username) {
    let tiktokConnection = new WebcastPushConnection(username);
    
    try {
        let state = await tiktokConnection.connect();
        
        if (state.isConnected) {
            tiktokConnection.disconnect();
            return { isLive: true };
        } else {
            return { isLive: false };
        }
    } catch (error) {
        return { isLive: false, error: error.message };
    }
}

// Fungsi untuk mengirim notifikasi
async function sendNotification(username) {
    const message = `🔴 *LIVE ALERT!*

[@${username}](https://www.tiktok.com/@${username}/live) sedang live sekarang!`;
    
    try {
        await bot.api.sendMessage(CHAT_ID, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        console.log(`📤 Notification sent for @${username}`);
    } catch (error) {
        console.error(`❌ Failed to send notification for @${username}:`, error.message);
    }
}

// Fungsi monitoring utama
async function startMonitoring() {
    if (monitoring) return;
    
    monitoring = true;
    console.log('🔄 Monitoring started');
    
    setInterval(async () => {
        if (monitoredUsers.length === 0) return;
        
        console.log(`🔍 Checking ${monitoredUsers.length} users...`);
        
        for (const username of monitoredUsers) {
            try {
                const liveInfo = await checkUserLive(username);
                const currentTime = Date.now();
                
                if (liveInfo.isLive) {
                    // User sedang live
                    if (!liveStatus[username]) {
                        // Baru mulai live, kirim notifikasi pertama
                        liveStatus[username] = {
                            isLive: true,
                            startTime: currentTime,
                            lastNotification: currentTime
                        };
                        await sendNotification(username);
                    } else if (liveStatus[username].isLive) {
                        // Masih live, check apakah sudah waktunya notifikasi lagi
                        const timeSinceLastNotif = currentTime - liveStatus[username].lastNotification;
                        
                        if (timeSinceLastNotif >= NOTIFICATION_INTERVAL) {
                            liveStatus[username].lastNotification = currentTime;
                            await sendNotification(username);
                        }
                    }
                } else {
                    // User tidak live
                    if (liveStatus[username] && liveStatus[username].isLive) {
                        // Baru saja berhenti live
                        console.log(`📴 @${username} stopped live streaming`);
                        delete liveStatus[username];
                    }
                }
                
                // Delay kecil antar request
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Error checking @${username}:`, error.message);
            }
        }
    }, CHECK_INTERVAL);
}

// Command handlers
bot.command('start', (ctx) => {
    const welcomeMessage = `🤖 *TikTok Live Monitor Bot*

Selamat datang! Bot ini akan memantau TikTok live stream.

*Commands:*
/add <username> - Tambah user untuk dimonitor
/remove <username> - Hapus user dari monitoring
/list - Lihat daftar user yang dimonitor
/status - Lihat status monitoring
/help - Bantuan

*Contoh:*
/add jktdreamer

⚡ Bot akan otomatis mengirim notifikasi saat user mulai live!`;
    
    ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
});

bot.command('help', (ctx) => {
    const helpMessage = `📖 *Bantuan TikTok Live Monitor*

*Cara Kerja:*
• Bot mengecek status live setiap 30 detik
• Notifikasi dikirim saat user mulai live
• Notifikasi lanjutan setiap 1 menit jika masih live

*Commands:*
• \`/add username\` - Tambah user baru
• \`/remove username\` - Hapus user
• \`/list\` - Daftar user yang dimonitor
• \`/status\` - Status monitoring

*Tips:*
• Username tanpa @ (contoh: jktdreamer)
• Bot hanya kirim notifikasi saat live
• Data tersimpan otomatis`;
    
    ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

bot.command('add', async (ctx) => {
    const username = ctx.match?.trim();
    
    if (!username) {
        return ctx.reply('❌ Masukkan username!\nContoh: `/add jktdreamer`', { parse_mode: 'Markdown' });
    }
    
    // Remove @ if present
    const cleanUsername = username.replace('@', '');
    
    if (monitoredUsers.includes(cleanUsername)) {
        return ctx.reply(`❌ User @${cleanUsername} sudah ada dalam monitoring!`);
    }
    
    // Test apakah username valid
    ctx.reply(`⏳ Mengecek username @${cleanUsername}...`);
    
    try {
        await checkUserLive(cleanUsername);
        monitoredUsers.push(cleanUsername);
        await saveMonitoredUsers();
        
        ctx.reply(`✅ User @${cleanUsername} berhasil ditambahkan!\n📊 Total: ${monitoredUsers.length} users`);
        console.log(`➕ Added user: @${cleanUsername}`);
    } catch (error) {
        ctx.reply(`❌ Error: Username @${cleanUsername} tidak valid atau tidak ditemukan!`);
    }
});

bot.command('remove', async (ctx) => {
    const username = ctx.match?.trim();
    
    if (!username) {
        return ctx.reply('❌ Masukkan username!\nContoh: `/remove jktdreamer`', { parse_mode: 'Markdown' });
    }
    
    const cleanUsername = username.replace('@', '');
    const index = monitoredUsers.indexOf(cleanUsername);
    
    if (index === -1) {
        return ctx.reply(`❌ User @${cleanUsername} tidak ditemukan dalam monitoring!`);
    }
    
    monitoredUsers.splice(index, 1);
    delete liveStatus[cleanUsername]; // Hapus dari live status juga
    await saveMonitoredUsers();
    
    ctx.reply(`✅ User @${cleanUsername} berhasil dihapus!\n📊 Total: ${monitoredUsers.length} users`);
    console.log(`➖ Removed user: @${cleanUsername}`);
});

bot.command('list', (ctx) => {
    if (monitoredUsers.length === 0) {
        return ctx.reply('📭 Belum ada user yang dimonitor.\nGunakan `/add <username>` untuk menambah user.', { parse_mode: 'Markdown' });
    }
    
    let message = `📋 *Daftar User yang Dimonitor* (${monitoredUsers.length})

`;
    
    monitoredUsers.forEach((username, index) => {
        const status = liveStatus[username] && liveStatus[username].isLive ? '🔴 LIVE' : '⚫ Offline';
        message += `${index + 1}. @${username} - ${status}\n`;
    });
    
    ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.command('status', (ctx) => {
    const liveCount = Object.keys(liveStatus).filter(user => liveStatus[user].isLive).length;
    const offlineCount = monitoredUsers.length - liveCount;
    
    const statusMessage = `📊 *Status Monitoring*

👥 Total Users: ${monitoredUsers.length}
🔴 Live: ${liveCount}
⚫ Offline: ${offlineCount}
🔄 Monitoring: ${monitoring ? 'Aktif' : 'Tidak Aktif'}
⏱️ Check Interval: ${CHECK_INTERVAL / 1000}s
🔔 Notif Interval: ${NOTIFICATION_INTERVAL / 1000}s`;
    
    ctx.reply(statusMessage, { parse_mode: 'Markdown' });
});

// Error handler
bot.catch((err) => {
    console.error('❌ Bot error:', err);
});

// Startup
async function main() {
    console.log('🚀 Starting TikTok Live Monitor Bot...');
    
    // Check environment variables
    if (!BOT_TOKEN || !CHAT_ID) {
        console.error('❌ BOT_TOKEN and CHAT_ID must be set in .env file');
        console.log('Create .env file with:');
        console.log('BOT_TOKEN=your_bot_token_here');
        console.log('CHAT_ID=your_chat_id_here');
        process.exit(1);
    }
    
    // Load data
    await loadMonitoredUsers();
    
    // Start monitoring
    startMonitoring();
    
    // Start bot
    await bot.start();
    console.log('✅ Bot started successfully!');
    console.log(`📊 Monitoring ${monitoredUsers.length} users`);
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down bot...');
    await saveMonitoredUsers();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n👋 Shutting down bot...');
    await saveMonitoredUsers();
    process.exit(0);
});

// Start the bot
main().catch(console.error);
