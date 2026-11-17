const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAGZrWnyjqNsFZlu_GqGZ_QWDMczVzFZjZw';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com';

const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

bot.setWebHook(`${RENDER_URL}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// دالة مشتركة لفحص المحفظة وإرسال النتيجة (سواء في الخاص أو القناة)
async function handleWalletCheck(chatId, text, messageId = null) {
    const words = text.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return; // إذا لم تكن 12 أو 24 كلمة، يتجاهلها البوت بصمت في القناة لكي لا يزعج الأعضاء
    }

    try {
        const cleanMnemonic = text.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ العبارة المرسلة غير صالحة وليست محفظة حقيقية.', { reply_to_message_id: messageId });
        }

        // 2. اشتقاق العنوان الحقيقي
        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        // 3. فحص الأرصدة عبر الشبكات
        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(address).catch(() => 0n),
            bscProvider.getBalance(address).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        // 4. إرسال تقرير الفحص
        return bot.sendMessage(chatId, 
            '🛡️ **تقرير فحص المحفظة المكتشفة:**\n\n' +
            '📍 **العنوان:**\n`' + address + '`\n\n' +
            '💰 **الأرصدة:**\n' +
            '• ETH: `' + ethBalance + '`\n' +
            '• BNB: `' + bscBalance + '`\n\n' +
            '🟢 حالة المحفظة: نشطة ومفعلة.',
            { reply_to_message_id: messageId }
        );

    } catch (error) {
        console.error("Error:", error);
    }
}

// أستقبال الرسائل في المحادثات الخاصة (Private Chat)
bot.on('message', async (msg) => {
    if (msg.chat.type === 'private' && msg.text) {
        if (msg.text === '/start') {
            return bot.sendMessage(msg.chat.id, '🛡️ أهلاً بك! أرسل عبارة الاسترداد في أي وقت لفحصها.');
        }
        await handleWalletCheck(msg.chat.id, msg.text, msg.message_id);
    }
});

// استقبال الرسائل في القنوات (Channel Posts)
bot.on('channel_post', async (msg) => {
    if (msg.text) {
        // فحص العبارة فور نشرها في القناة
        await handleWalletCheck(msg.chat.id, msg.text, msg.message_id);
    }
});

app.get('/', (req, res) => {
    res.send('Channel & Private Wallet Checker Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
