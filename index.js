const express = require('express');
const { ethers } = require('ethers');
const bip39 = require('bip39');

const app = express();
app.use(express.json());

app.post('/check-wallet', async (req, res) => {
    try {
        const { mnemonic } = req.body;

        if (!mnemonic || typeof mnemonic !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid input' });
        }

        const cleanMnemonic = mnemonic.trim().toLowerCase();
        if (!bip39.validateMnemonic(cleanMnemonic)) {
            return res.json({ 
                success: true, 
                valid: false, 
                message: '❌ العبارة غير صحيحة أو ليست عبارة استرداد صالحة بمعيار BIP39.' 
            });
        }

        const seed = await bip39.mnemonicToSeed(cleanMnemonic);
        const hdNode = ethers.HDNodeWallet.fromSeed(seed);
        const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
        const address = wallet.address;

        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const balanceWei = await provider.getBalance(address);
        const balanceEth = ethers.formatEther(balanceWei);

        return res.json({
            success: true,
            valid: true,
            address: address,
            balance: balanceEth,
            network: 'Ethereum / EVM'
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: 'Blockchain connection error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
