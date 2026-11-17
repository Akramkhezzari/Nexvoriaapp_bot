const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAGZrWnyjqNsFZlu_GqGZ_QWDMczVzFZjZw';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com';

// معرف القناة المستهدفة (يمكنك استخدام الرقم المباشر أو بصيغة -100)
const TARGET_CHANNEL_ID = '-1003203792121'; 
const TARGET_CHANNEL_ID_ALT = '3203792121';

const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

bot.setWebHook(`${RENDER_URL}/bot${token}`);

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// التعامل مع المنشورات الجديدة داخل القناة
bot.on('channel_post', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = (msg.text || '').trim();

    // التأكد من أن المنشور صادر من قناتك حصراً
    if (chatId !== TARGET_CHANNEL_ID && chatId !== TARGET_CHANNEL_ID_ALT) {
        return;
    }

    // تجاهل رسائل البوت نفسه لمنع التكرار اللانهائي
    if (msg.from && msg.from.is_bot) {
        return;
    }

    const words = text.split(/\s+/);
    
    // التحقق عما إذا كانت الرسالة عبارة استرداد (12 أو 24 كلمة)
    if (words.length !== 12 && words.length !== 24) {
        return;
    }

    try {
        const cleanMnemonic = text.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            // يمكنك اختيار عدم الرد أو الرد برسالة تنبيه بأن العبارة غير صالحة
            return;
        }

        // 2. اشتقاق العناوين ومفاتيح EVM
        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;
        const privateKey = wallet.privateKey;

        // 3. فحص الأرصدة الحقيقية عبر شبكات متعددة (Ethereum & BSC)
        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(address).catch(() => 0n),
            bscProvider.getBalance(address).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        // 4. بناء تقرير الإحصائيات الشامل لنشره في القناة
        const statsReport = 
            '📊 **إحصائيات ونتيجة فحص المحفظة التلقائي:**\n\n' +
            '🔑 **العبارة المفحوصة:**\n' +
            `\`${text}\`\n\n` +
            '📍 **العنوان المشتق (EVM):**\n' +
            `\`${address}\`\n\n` +
            '🔐 **المفتاح الخاص (Private Key):**\n' +
            `\`${privateKey}\`\n\n` +
            '💰 **الأرصدة المكتشفة:**\n' +
            `• Ethereum (ETH): \`${ethBalance} ETH\`\n` +
            `• BNB Smart Chain (BNB): \`${bscBalance} BNB\`\n\n` +
            '🟢 **حالة المحفظة:** نشطة ومعتمدة على البلوكشين.';

        // نشر الإحصائيات في القناة (ردًا على الرسالة الأصلية أو كرسالة جديدة)
        await bot.sendMessage(chatId, statsReport, { 
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id // لكي يتم الرد مباشرة تحت العبارة المرسلة
        });

    } catch (error) {
        console.error("Error processing channel post:", error);
    }
});

app.get('/', (req, res) => {
    res.send('Channel Wallet Checker Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
