"use strict";

/**
 * The asset a payment is made in. HBAR (native) and one HTS fungible token (USDC) are supported.
 *
 * Amounts are always integers in the asset's smallest unit: tinybars for HBAR, and for a token the
 * token's own base unit (USDC has 6 decimals, so 1 USDC = 1_000_000). The store column and the
 * `tinybars` field keep their historical names; for a token they hold token units.
 *
 * A token is treated as worth exactly one US dollar (a USD stablecoin). That is what makes the quote
 * exact: no exchange rate is involved. Do not configure a token that is not pegged to $1.
 */

const HBAR_ASSET_ID = "0.0.0";
const TESTNET_USDC_ID = "0.0.429274";
const USDC_DECIMALS = 6;
const ENTITY_ID = /^0\.0\.\d{1,12}$/;

const HBAR = Object.freeze({ id: HBAR_ASSET_ID, symbol: "HBAR", decimals: 8, native: true, unit: "tinybars" });

function tokenAsset({ id = TESTNET_USDC_ID, symbol = "USDC", decimals = USDC_DECIMALS } = {}) {
    if (!ENTITY_ID.test(id) || id === HBAR_ASSET_ID) throw new Error(`Token id must look like 0.0.1234, got '${id}'`);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Token decimals must be a whole number from 0 to 18");
    return Object.freeze({ id, symbol, decimals, native: false, unit: `${symbol} units` });
}

/** Rebuilds a descriptor stored with a quote. Quotes created before tokens existed have none and are HBAR. */
function assetFromStored(value) {
    if (!value) return HBAR;
    if (value.id === HBAR_ASSET_ID) return HBAR;
    return tokenAsset(value);
}

/** The descriptor as stored with a quote, with only what is needed to rebuild it. */
const storableAsset = (asset) => ({ id: asset.id, symbol: asset.symbol, decimals: asset.decimals });

const pow10 = (n) => 10n ** BigInt(n);

/** 150000 USDC units to "0.15", 100000000 tinybars to "1". Exact, no floating point. */
function formatAmount(amount, asset = HBAR) {
    const value = BigInt(amount);
    const scale = pow10(asset.decimals);
    const whole = value / scale;
    if (asset.decimals === 0) return `${whole}`;
    const fraction = (value % scale).toString().padStart(asset.decimals, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** USD to token units, rounded up at micro-dollar precision. A $1 token has no exchange rate. */
function usdToTokenUnits(usd, asset) {
    if (asset.native) throw new Error("usdToTokenUnits is for tokens; HBAR needs an exchange rate");
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new Error("USD amount must be a positive finite number");
    const micro = BigInt(Math.round(usd * 1_000_000));
    if (micro <= 0n) throw new Error("USD amount is too small to convert");
    const scaled = micro * pow10(asset.decimals);
    return (scaled + 999_999n) / 1_000_000n;
}

/** The fixed "rate" stored with a token quote, so the quote record has the same shape either way. */
function pegRate(asset, now = Date.now()) {
    return { source: "usd-peg", asset: asset.id, usdPerUnit: 1, usdPerHbar: null, validUntil: now + 365 * 24 * 3600 * 1000 };
}

/** A short label for logs and messages: "USDC (0.0.429274)". */
const describe = (asset) => (asset.native ? asset.symbol : `${asset.symbol} (${asset.id})`);

module.exports = {
    HBAR, HBAR_ASSET_ID, TESTNET_USDC_ID, USDC_DECIMALS,
    tokenAsset, assetFromStored, storableAsset, formatAmount, usdToTokenUnits, pegRate, describe,
};
