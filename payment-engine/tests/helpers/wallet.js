"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { PrivateKey, Transaction } = require("@hiero-ledger/sdk");
const { proto } = require("@hiero-ledger/proto");
const { SimLedger } = require("../../service/sim-ledger");
const { startTestService, WALLET } = require("./service");

// The REAL browser transaction builder, not a copy. Node strips its types and runs it as it is.
const BUILDER = path.resolve(__dirname, "../../../frontend/lib/payments/payment-transaction.ts");
let builder;
const loadBuilder = () => (builder ??= import(pathToFileURL(BUILDER).href));

/**
 * Stands in for a Hedera wallet, signing the way WalletConnect's hedera_signTransaction does: the wallet
 * signs ONE transaction body, and the signature is merged into the transaction. A real wallet is
 * not available in tests, and this is the same arithmetic. It cannot tell whether HashPack itself
 * will agree to sign. That has to be tried with the real wallet.
 */
function standInWallet(key) {
    return async (tx) => {
        const list = proto.TransactionList.decode(tx.toBytes());
        const merged = list.transactionList.map((entry) => {
            const signed = proto.SignedTransaction.decode(entry.signedTransactionBytes);
            // HashPack decodes the transaction and signs its OWN re-encoding of the body, which omits
            // zero-valued fields; it then attaches that signature to the transaction it was given.
            const reencoded = proto.TransactionBody.encode(proto.TransactionBody.decode(signed.bodyBytes)).finish();
            const signature = key.sign(reencoded);
            const field = key.type === "ED25519" ? { ed25519: signature } : { ECDSASecp256k1: signature };
            const pair = { pubKeyPrefix: key.publicKey.toBytesRaw(), ...field };
            return {
                signedTransactionBytes: proto.SignedTransaction.encode({
                    bodyBytes: signed.bodyBytes,
                    sigMap: proto.SignatureMap.create({ sigPair: [...(signed.sigMap?.sigPair || []), pair] }),
                }).finish(),
            };
        });
        return Transaction.fromBytes(proto.TransactionList.encode({ transactionList: merged }).finish());
    };
}

const HBAR = 100_000_000n;

/**
 * Starts the service in wallet mode: the user's wallet pays, and nothing is signed by the server.
 * The user's account exists on the simulated ledger with a key and a balance, like a funded testnet account.
 */
async function startWalletService({ env = {}, overrides = {}, balanceHbar = 1000n, account = WALLET, tokens = {} } = {}) {
    const userKey = PrivateKey.generateECDSA();
    const ledger = overrides.ledger || new SimLedger();
    ledger.addAccount(account, { key: userKey.publicKey, balance: balanceHbar * HBAR, tokens });
    const svc = await startTestService({ env: { PAYER_MODE: "wallet", ...env }, overrides: { ...overrides, ledger } });

    return Object.assign(svc, {
        userKey,
        account,
        ledger,
        userBalance: () => ledger.balanceOf(account),
        merchantBalance: () => ledger.balanceOf(svc.services.accounts.merchant),
    });
}

/**
 * What the browser does after the user clicks pay: fetch the payment terms, build the transfer, have the
 * wallet sign it, and submit it. `mutate` lets a test tamper with the signed payment on its way to the server.
 */
async function walletPay(svc, paymentId, { key = svc.userKey, account = svc.account, mutateRequired = null, mutatePayload = null, nodeAccountId } = {}) {
    const { createSignedPayment } = await loadBuilder();
    const requirements = await svc.call("GET", `/v1/payments/${paymentId}/requirements`);
    if (requirements.status !== 200) return { requirements, submit: null };

    const body = requirements.body;
    const required = mutateRequired ? mutateRequired(structuredClone(body.required)) : body.required;
    const expected = mutateRequired ? { payTo: required.accepts[0].payTo, tinybars: required.accepts[0].amount } : body.expected;
    const { payload } = await createSignedPayment({
        required, expected, payerAccountId: account, memo: body.memo, signTransaction: standInWallet(key), nodeAccountId,
    });
    const submit = await svc.call("POST", `/v1/payments/${paymentId}/submit`, { paymentPayload: mutatePayload ? mutatePayload(payload) : payload });
    return { requirements, payload, submit };
}

module.exports = { startWalletService, walletPay, standInWallet, loadBuilder, HBAR };
