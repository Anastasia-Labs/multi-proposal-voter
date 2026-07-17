"use strict";

const NETWORK_ID = 1;
const MAX_PROPOSALS = 20;
const FEE_MARGIN = 5000n;
const VOTE_CODES = Object.freeze({ no: 0, yes: 1, abstain: 2 });

const state = {
  network: null,
  feeApi: null,
  drepApi: null,
  drepKeyHash: "",
  drepPublicKey: "",
  validatedKeys: new Set(),
  unsignedTx: "",
  bodyHash: "",
  feeWitness: "",
  plan: null,
  submitted: false,
};

const MASK_64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function normalizeHex(value) {
  return String(value || "").trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
}

function assertHex(hex, label) {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`${label} is not valid hexadecimal data.`);
}

function hexToBytes(hex) {
  const normalized = normalizeHex(hex);
  assertHex(normalized, "Hex value");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...chunks) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function compareCanonical(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  const leftHex = bytesToHex(left);
  const rightHex = bytesToHex(right);
  return leftHex < rightHex ? -1 : leftHex > rightHex ? 1 : 0;
}

function read64LE(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function rotateRight64(value, amount) {
  const shift = BigInt(amount);
  return ((value >> shift) | (value << (64n - shift))) & MASK_64;
}

function blake2b(input, outputLength) {
  if (!(input instanceof Uint8Array) || outputLength < 1 || outputLength > 64) throw new Error("Invalid Blake2b input.");
  const h = BLAKE2B_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outputLength);
  const compress = (block, count, last) => {
    const m = Array.from({ length: 16 }, (_, index) => read64LE(block, index * 8));
    const v = [...h, ...BLAKE2B_IV];
    v[12] ^= count & MASK_64;
    v[13] ^= count >> 64n;
    if (last) v[14] ^= MASK_64;
    const mix = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) & MASK_64; v[d] = rotateRight64(v[d] ^ v[a], 32);
      v[c] = (v[c] + v[d]) & MASK_64; v[b] = rotateRight64(v[b] ^ v[c], 24);
      v[a] = (v[a] + v[b] + y) & MASK_64; v[d] = rotateRight64(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) & MASK_64; v[b] = rotateRight64(v[b] ^ v[c], 63);
    };
    for (const s of BLAKE2B_SIGMA) {
      mix(0, 4, 8, 12, m[s[0]], m[s[1]]); mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
      mix(2, 6, 10, 14, m[s[4]], m[s[5]]); mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
      mix(0, 5, 10, 15, m[s[8]], m[s[9]]); mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
      mix(2, 7, 8, 13, m[s[12]], m[s[13]]); mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] ^ v[i] ^ v[i + 8]) & MASK_64;
  };
  let offset = 0;
  let count = 0n;
  while (offset + 128 < input.length) { count += 128n; compress(input.slice(offset, offset + 128), count, false); offset += 128; }
  const finalBlock = new Uint8Array(128);
  finalBlock.set(input.slice(offset));
  count += BigInt(input.length - offset);
  compress(finalBlock, count, true);
  const output = new Uint8Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) output[i] = Number((h[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xffn);
  return output;
}

function ensureBytes(bytes, offset, length, context) {
  if (offset + length > bytes.length) throw new Error(`Unexpected end of CBOR while reading ${context}.`);
}

function readBigEndian(bytes, offset, length) {
  ensureBytes(bytes, offset, length, "integer");
  let value = 0n;
  for (let i = 0; i < length; i += 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function safeNumber(value, context) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${context} is too large.`);
  return Number(value);
}

function readHeader(bytes, offset = 0) {
  ensureBytes(bytes, offset, 1, "initial byte");
  const first = bytes[offset];
  const major = first >> 5;
  const additional = first & 31;
  let cursor = offset + 1;
  let value = null;
  if (additional < 24) value = BigInt(additional);
  else if (additional >= 24 && additional <= 27) {
    const sizes = { 24: 1, 25: 2, 26: 4, 27: 8 };
    value = readBigEndian(bytes, cursor, sizes[additional]);
    cursor += sizes[additional];
  } else if (additional !== 31) throw new Error("Invalid CBOR header.");
  return { major, additional, value, cursor };
}

function skipItem(bytes, offset) {
  const header = readHeader(bytes, offset);
  let cursor = header.cursor;
  if (header.major <= 1) return cursor;
  if (header.major === 2 || header.major === 3) {
    if (header.additional === 31) { while (bytes[cursor] !== 0xff) cursor = skipItem(bytes, cursor); return cursor + 1; }
    const length = safeNumber(header.value, "CBOR string length"); ensureBytes(bytes, cursor, length, "string"); return cursor + length;
  }
  if (header.major === 4 || header.major === 5) {
    const multiplier = header.major === 5 ? 2 : 1;
    if (header.additional === 31) { while (bytes[cursor] !== 0xff) for (let i = 0; i < multiplier; i += 1) cursor = skipItem(bytes, cursor); return cursor + 1; }
    const count = safeNumber(header.value, "collection length") * multiplier;
    for (let i = 0; i < count; i += 1) cursor = skipItem(bytes, cursor);
    return cursor;
  }
  if (header.major === 6) return skipItem(bytes, cursor);
  if (header.major === 7 && header.additional !== 31) return cursor;
  throw new Error("Unsupported CBOR item.");
}

function readArrayItems(bytes, requireFull = true) {
  const header = readHeader(bytes);
  if (header.major !== 4) throw new Error("Expected a CBOR array.");
  const items = [];
  let cursor = header.cursor;
  const add = () => { const start = cursor; cursor = skipItem(bytes, cursor); items.push(bytes.slice(start, cursor)); };
  if (header.additional === 31) { while (bytes[cursor] !== 0xff) add(); cursor += 1; }
  else for (let i = 0; i < safeNumber(header.value, "array length"); i += 1) add();
  if (requireFull && cursor !== bytes.length) throw new Error("Trailing bytes after CBOR array.");
  return items;
}

function decodeUnsigned(raw) {
  const header = readHeader(raw);
  if (header.major !== 0 || header.additional === 31 || header.cursor !== raw.length) throw new Error("Expected a CBOR unsigned integer.");
  return header.value;
}

function readMapEntries(bytes, requireFull = true) {
  const header = readHeader(bytes);
  if (header.major !== 5) throw new Error("Expected a CBOR map.");
  const entries = [];
  let cursor = header.cursor;
  const add = () => {
    const keyStart = cursor; cursor = skipItem(bytes, cursor); const valueStart = cursor; cursor = skipItem(bytes, cursor);
    entries.push({ keyRaw: bytes.slice(keyStart, valueStart), valueRaw: bytes.slice(valueStart, cursor) });
  };
  if (header.additional === 31) { while (bytes[cursor] !== 0xff) add(); cursor += 1; }
  else for (let i = 0; i < safeNumber(header.value, "map length"); i += 1) add();
  if (requireFull && cursor !== bytes.length) throw new Error("Trailing bytes after CBOR map.");
  return entries;
}

function byteStringPayload(raw) {
  const header = readHeader(raw);
  if (header.major !== 2 || header.additional === 31) throw new Error("Expected a definite CBOR byte string.");
  const length = safeNumber(header.value, "byte string length");
  if (header.cursor + length !== raw.length) throw new Error("Invalid CBOR byte string.");
  return raw.slice(header.cursor);
}

function unwrapTags(raw) {
  let bytes = raw;
  while (readHeader(bytes).major === 6) {
    const header = readHeader(bytes);
    const end = skipItem(bytes, header.cursor);
    bytes = bytes.slice(header.cursor, end);
  }
  return bytes;
}

function encodeTypeLength(major, value) {
  const length = BigInt(value);
  const head = major << 5;
  if (length < 24n) return Uint8Array.of(head | Number(length));
  if (length <= 0xffn) return Uint8Array.of(head | 24, Number(length));
  if (length <= 0xffffn) return Uint8Array.of(head | 25, Number(length >> 8n), Number(length & 0xffn));
  if (length <= 0xffffffffn) return Uint8Array.of(head | 26, Number((length >> 24n) & 0xffn), Number((length >> 16n) & 0xffn), Number((length >> 8n) & 0xffn), Number(length & 0xffn));
  const output = new Uint8Array(9); output[0] = head | 27;
  for (let i = 8; i >= 1; i -= 1) output[i] = Number((length >> BigInt((8 - i) * 8)) & 0xffn);
  return output;
}

function encodeUInt(value) { return encodeTypeLength(0, BigInt(value)); }
function encodeBytes(bytes) { return concatBytes(encodeTypeLength(2, bytes.length), bytes); }
function encodeArray(items) { return concatBytes(encodeTypeLength(4, items.length), ...items); }
function encodeTag(tag, item) { return concatBytes(encodeTypeLength(6, tag), item); }
function encodeMap(pairs) {
  const sorted = pairs.slice().sort((left, right) => compareCanonical(left[0], right[0]));
  return concatBytes(encodeTypeLength(5, sorted.length), ...sorted.flatMap(([key, value]) => [key, value]));
}

function encodeValue(coin, multiassetRaw) {
  return multiassetRaw ? encodeArray([encodeUInt(coin), multiassetRaw]) : encodeUInt(coin);
}

function parseValue(raw) {
  const header = readHeader(raw);
  if (header.major === 0) return { coin: decodeUnsigned(raw), multiassetRaw: null };
  if (header.major !== 4) throw new Error("Unsupported UTxO value encoding.");
  const items = readArrayItems(raw);
  if (items.length !== 2 || readHeader(items[1]).major !== 5) throw new Error("Malformed multi-asset value.");
  return { coin: decodeUnsigned(items[0]), multiassetRaw: items[1] };
}

function parseWalletUtxo(utxoHex) {
  const outer = readArrayItems(unwrapTags(hexToBytes(utxoHex)));
  if (outer.length !== 2) throw new Error("Malformed wallet UTxO.");
  const inputRaw = unwrapTags(outer[0]);
  const input = readArrayItems(inputRaw);
  if (input.length !== 2) throw new Error("Malformed transaction input.");
  const txHash = bytesToHex(byteStringPayload(input[0]));
  const index = decodeUnsigned(input[1]);

  const outputRaw = unwrapTags(outer[1]);
  const outputHeader = readHeader(outputRaw);
  let addressRaw;
  let valueRaw;
  if (outputHeader.major === 4) {
    const output = readArrayItems(outputRaw);
    if (output.length < 2) throw new Error("Malformed legacy transaction output.");
    [addressRaw, valueRaw] = output;
  } else if (outputHeader.major === 5) {
    const entries = readMapEntries(outputRaw);
    addressRaw = entries.find((entry) => decodeUnsigned(entry.keyRaw) === 0n)?.valueRaw;
    valueRaw = entries.find((entry) => decodeUnsigned(entry.keyRaw) === 1n)?.valueRaw;
    if (!addressRaw || !valueRaw) throw new Error("Malformed Babbage transaction output.");
  } else throw new Error("Unsupported transaction output encoding.");

  const address = byteStringPayload(addressRaw);
  if (address.length < 29) throw new Error("Unsupported fee input address.");
  const addressType = address[0] >> 4;
  if (![0, 2, 4, 6].includes(addressType)) throw new Error("Fee input is not controlled by a payment key.");
  const value = parseValue(valueRaw);
  return {
    txHash,
    index,
    inputRaw,
    address,
    paymentKeyHash: bytesToHex(address.slice(1, 29)),
    coin: value.coin,
    multiassetRaw: value.multiassetRaw,
  };
}

function encodeVotingProcedures(actions, drepKeyHash) {
  const actionPairs = actions.map((action) => [
    encodeArray([encodeBytes(hexToBytes(action.txHash)), encodeUInt(action.index)]),
    encodeArray([encodeUInt(VOTE_CODES[action.vote]), Uint8Array.of(0xf6)]),
  ]);
  const voter = encodeArray([encodeUInt(2), encodeBytes(hexToBytes(drepKeyHash))]);
  return encodeMap([[voter, encodeMap(actionPairs)]]);
}

function buildTransaction(inputs, totalCoin, multiassetRaw, actions, drepKeyHash, changeAddress, fee, witnessSet = Uint8Array.of(0xa0)) {
  const sortedInputs = inputs.map((input) => input.inputRaw).sort(compareCanonical);
  const change = totalCoin - fee;
  if (change <= 0n) throw new Error("Selected inputs do not cover the transaction fee.");
  const output = encodeArray([encodeBytes(changeAddress), encodeValue(change, multiassetRaw)]);
  const body = encodeMap([
    [encodeUInt(0), encodeTag(258, encodeArray(sortedInputs))],
    [encodeUInt(1), encodeArray([output])],
    [encodeUInt(2), encodeUInt(fee)],
    [encodeUInt(15), encodeUInt(NETWORK_ID)],
    [encodeUInt(19), encodeVotingProcedures(actions, drepKeyHash)],
  ]);
  const transaction = encodeArray([body, witnessSet, Uint8Array.of(0xf5), Uint8Array.of(0xf6)]);
  return { body, transaction, output, change, fee };
}

function dummyWitnessSet(count) {
  const witness = encodeArray([encodeBytes(new Uint8Array(32)), encodeBytes(new Uint8Array(64))]);
  return encodeMap([[encodeUInt(0), encodeArray(Array.from({ length: count }, () => witness))]]);
}

function calculatePlan(inputs, multiassetRaw, actions, drepKeyHash, changeAddress, network) {
  const totalCoin = inputs.reduce((sum, input) => sum + input.coin, 0n);
  const paymentHashes = [...new Set(inputs.map((input) => input.paymentKeyHash))];
  let fee = 200000n;
  let built;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    built = buildTransaction(inputs, totalCoin, multiassetRaw, actions, drepKeyHash, changeAddress, fee);
    const estimated = buildTransaction(
      inputs,
      totalCoin,
      multiassetRaw,
      actions,
      drepKeyHash,
      changeAddress,
      fee,
      dummyWitnessSet(paymentHashes.length + 1),
    );
    const nextFee = BigInt(network.txFeeFixed) + BigInt(network.txFeePerByte) * BigInt(estimated.transaction.length) + FEE_MARGIN;
    if (nextFee === fee) break;
    fee = nextFee;
  }
  built = buildTransaction(inputs, totalCoin, multiassetRaw, actions, drepKeyHash, changeAddress, fee);
  const minimumAda = BigInt(network.utxoCostPerByte) * BigInt(160 + built.output.length);
  if (built.change < minimumAda) throw new Error(`Change would be below minimum ADA (${formatAda(minimumAda)} ADA).`);
  const estimated = buildTransaction(inputs, totalCoin, multiassetRaw, actions, drepKeyHash, changeAddress, fee, dummyWitnessSet(paymentHashes.length + 1));
  if (estimated.transaction.length > network.maxTxSize) throw new Error("Transaction exceeds the current maximum size.");
  return { ...built, inputs, multiassetRaw, totalCoin, paymentHashes, minimumAda, estimatedSize: estimated.transaction.length, drepKeyHash, changeAddress };
}

function choosePlan(utxos, actions, drepKeyHash, changeAddress, network) {
  const compareCoin = (left, right) => left.coin < right.coin ? -1 : left.coin > right.coin ? 1 : 0;
  const pure = utxos.filter((utxo) => !utxo.multiassetRaw).sort(compareCoin);
  for (const utxo of pure) {
    try { return calculatePlan([utxo], null, actions, drepKeyHash, changeAddress, network); } catch (_error) { /* try next */ }
  }
  if (pure.length > 1) {
    const descending = pure.slice().sort((left, right) => compareCoin(right, left));
    const selected = [];
    for (const utxo of descending) {
      selected.push(utxo);
      try { return calculatePlan(selected, null, actions, drepKeyHash, changeAddress, network); } catch (_error) { /* add another */ }
    }
  }
  const tokenUtxos = utxos.filter((utxo) => utxo.multiassetRaw).sort(compareCoin);
  for (const utxo of tokenUtxos) {
    try { return calculatePlan([utxo], utxo.multiassetRaw, actions, drepKeyHash, changeAddress, network); } catch (_error) { /* try next */ }
  }
  throw new Error("No suitable key-controlled UTxO can cover the fee and minimum change. Create a clean ADA UTxO of at least 1.5 ADA and retry.");
}

function transactionItems(txHex) {
  const items = readArrayItems(hexToBytes(txHex));
  if (items.length !== 4) throw new Error("Expected a four-item Conway transaction.");
  return items;
}

function unwrapWalletHex(result, label) {
  const value = typeof result === "string" ? result : result && typeof result.cbor === "string" ? result.cbor : "";
  const hex = normalizeHex(value);
  assertHex(hex, label);
  return hex;
}

function vkeyWitnesses(witnessHex) {
  const entries = readMapEntries(hexToBytes(witnessHex));
  const unexpected = entries.filter((entry) => decodeUnsigned(entry.keyRaw) !== 0n);
  if (unexpected.length) throw new Error("Wallet returned an unexpected non-key witness.");
  const vkeys = entries.find((entry) => decodeUnsigned(entry.keyRaw) === 0n);
  if (!vkeys) return [];
  return readArrayItems(unwrapTags(vkeys.valueRaw)).map((raw) => {
    const pair = readArrayItems(raw);
    if (pair.length !== 2) throw new Error("Malformed key witness.");
    const publicKey = byteStringPayload(pair[0]);
    const signature = byteStringPayload(pair[1]);
    if (publicKey.length !== 32 || signature.length !== 64) throw new Error("Malformed Ed25519 witness.");
    return { raw, publicKey, signature, keyHash: bytesToHex(blake2b(publicKey, 28)) };
  });
}

async function verifyWitnessSet(witnessHex, expectedHashes, txHex, role) {
  const witnesses = vkeyWitnesses(witnessHex);
  const message = blake2b(transactionItems(txHex)[0], 32);
  for (const expectedHash of expectedHashes) {
    const witness = witnesses.find((candidate) => candidate.keyHash === expectedHash);
    if (!witness) throw new Error(`${role} did not return required witness ${expectedHash}.`);
    const key = await crypto.subtle.importKey("raw", witness.publicKey, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, witness.signature, message);
    if (!valid) throw new Error(`${role} returned an invalid signature.`);
  }
  return witnesses;
}

function mergeWitnessSets(...witnessHexes) {
  const seen = new Set();
  const witnesses = [];
  for (const witnessHex of witnessHexes) {
    for (const witness of vkeyWitnesses(witnessHex)) {
      const id = bytesToHex(witness.raw);
      if (!seen.has(id)) { seen.add(id); witnesses.push(witness.raw); }
    }
  }
  witnesses.sort(compareCanonical);
  return encodeMap([[encodeUInt(0), encodeArray(witnesses)]]);
}

function assembleTransaction(txHex, ...witnessHexes) {
  const items = transactionItems(txHex);
  return bytesToHex(encodeArray([items[0], mergeWitnessSets(...witnessHexes), items[2], items[3]]));
}

function parseGovernanceAction(value) {
  let token = String(value || "").trim();
  if (!token) throw new Error("Governance action is empty.");
  if (/^https?:\/\//i.test(token)) {
    const url = new URL(token);
    token = url.pathname.split("/").filter(Boolean).pop() || "";
  }
  token = token.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  const hashIndex = token.match(/^([0-9a-f]{64})#([0-9]{1,5})$/);
  if (hashIndex) {
    const index = Number(hashIndex[2]);
    if (index > 65535) throw new Error("Governance action index exceeds 65535.");
    return { txHash: hashIndex[1], index, key: `${hashIndex[1]}#${index}` };
  }
  if (!/^[0-9a-f]+$/.test(token) || token.length < 66 || token.length > 68 || token.length % 2 !== 0) {
    throw new Error("Use an AdaStat governance URL, 64-character transaction hash plus action-index hex, or txHash#index.");
  }
  const txHash = token.slice(0, 64);
  const index = Number.parseInt(token.slice(64), 16);
  return { txHash, index, key: `${txHash}#${index}` };
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) checksum ^= generators[i];
  }
  return checksum >>> 0;
}

function bech32Encode(hrp, bytes) {
  const data = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; data.push((accumulator >>> bits) & 31); }
  }
  if (bits > 0) data.push((accumulator << (5 - bits)) & 31);
  const expanded = [...hrp].map((char) => char.charCodeAt(0) >>> 5).concat([0], [...hrp].map((char) => char.charCodeAt(0) & 31));
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return `${hrp}1${[...data, ...checksum].map((value) => charset[value]).join("")}`;
}

function drepIdFromHash(hash) {
  return bech32Encode("drep", concatBytes(Uint8Array.of(0x22), hexToBytes(hash)));
}

function formatAda(lovelace) {
  const value = BigInt(lovelace);
  const whole = value / 1000000n;
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function providerList() {
  if (!window.cardano || typeof window.cardano !== "object") return [];
  return Object.entries(window.cardano)
    .filter(([, provider]) => provider && typeof provider.enable === "function")
    .map(([key, provider]) => ({ key, provider, name: provider.name || key }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function describeError(error) {
  if (!error) return "Unknown error.";
  return [error.code !== undefined ? `code ${error.code}` : "", error.info || "", error.message || ""].filter(Boolean).join(": ") || String(error);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

function bootstrap() {
  const ids = [
    "networkState", "addProposal", "proposalRows", "proposalSummary", "validateProposals", "proposalTemplate",
    "refreshWallets", "feeWallet", "drepWallet", "feeState", "drepState", "connectFee", "connectDrep", "drepId",
    "txSummary", "summaryVotes", "summaryInputs", "summaryFee", "summaryChange", "summaryHash", "resetTransaction",
    "signFee", "signDrepSubmit", "submission", "submittedTx", "statusLog", "clearLog",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  const log = (message, level = "info") => {
    elements.statusLog.textContent += `[${new Date().toLocaleTimeString()}] ${level}: ${message}\n`;
    elements.statusLog.scrollTop = elements.statusLog.scrollHeight;
  };
  const setState = (element, text, kind = "") => { element.textContent = text; element.className = `state ${kind}`.trim(); };

  const proposalRows = () => Array.from(elements.proposalRows.querySelectorAll(".proposal-row"));

  const updateActions = () => {
    let votesReady = proposalRows().length > 0;
    for (const row of proposalRows()) votesReady &&= Boolean(row.dataset.vote);
    elements.signFee.disabled = !(
      state.network && state.feeApi && state.drepKeyHash && state.validatedKeys.size === proposalRows().length && votesReady && !state.unsignedTx
    );
    elements.signDrepSubmit.disabled = !(state.unsignedTx && state.feeWitness && state.drepApi && !state.submitted);
    elements.resetTransaction.disabled = !state.unsignedTx;
  };

  const invalidateTransaction = () => {
    if (!state.unsignedTx) return;
    state.unsignedTx = ""; state.bodyHash = ""; state.feeWitness = ""; state.plan = null; state.submitted = false;
    elements.txSummary.hidden = true; elements.submission.hidden = true;
    for (const control of elements.proposalRows.querySelectorAll("input, .vote-control button, .remove-proposal")) control.disabled = false;
    updateActions();
    log("Unsigned transaction reset. Proposal choices are editable again.", "warn");
  };

  const invalidateValidation = () => {
    invalidateTransaction();
    state.validatedKeys.clear();
    elements.proposalSummary.textContent = "Proposal validation required";
    updateActions();
  };

  const addRow = (initialValue = "") => {
    if (proposalRows().length >= MAX_PROPOSALS) { log(`A maximum of ${MAX_PROPOSALS} proposals is supported.`, "error"); return; }
    const row = elements.proposalTemplate.content.firstElementChild.cloneNode(true);
    const input = row.querySelector(".proposal-input");
    const status = row.querySelector(".proposal-status");
    input.value = initialValue;
    input.addEventListener("input", () => { status.textContent = ""; status.className = "proposal-status"; invalidateValidation(); });
    for (const button of row.querySelectorAll("[data-vote]")) {
      button.addEventListener("click", () => {
        row.dataset.vote = button.dataset.vote;
        for (const peer of row.querySelectorAll("[data-vote]")) peer.classList.toggle("selected", peer === button);
        invalidateTransaction(); updateActions();
      });
    }
    row.querySelector(".remove-proposal").addEventListener("click", () => {
      row.remove();
      if (proposalRows().length === 0) addRow();
      invalidateValidation();
    });
    elements.proposalRows.append(row);
    updateActions();
  };

  const collectActions = (requireVotes = false) => {
    const actions = [];
    const seen = new Set();
    for (const row of proposalRows()) {
      const action = parseGovernanceAction(row.querySelector(".proposal-input").value);
      if (seen.has(action.key)) throw new Error(`Duplicate governance action ${action.key}.`);
      seen.add(action.key);
      if (requireVotes && !row.dataset.vote) throw new Error(`Choose Yes, No, or Abstain for ${action.key}.`);
      actions.push({ ...action, vote: row.dataset.vote || "" });
    }
    return actions;
  };

  const refreshWallets = (quiet = false) => {
    const providers = providerList();
    for (const select of [elements.feeWallet, elements.drepWallet]) {
      const previous = select.value;
      select.replaceChildren();
      if (providers.length === 0) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "No CIP-30 wallet detected"; select.append(option);
      } else {
        for (const item of providers) { const option = document.createElement("option"); option.value = item.key; option.textContent = item.name; select.append(option); }
        if (providers.some((item) => item.key === previous)) select.value = previous;
      }
    }
    if (!quiet) {
      const message = providers.length
        ? `Detected ${providers.length} wallet provider${providers.length === 1 ? "" : "s"}.`
        : window.location.protocol === "file:"
          ? "Wallet extensions do not inject into file:// pages. Run server.py and open its localhost URL in regular Chrome."
          : "No window.cardano provider detected in this browser profile.";
      log(message, providers.length ? "ok" : "warn");
    }
  };

  const selectedProvider = (select) => {
    refreshWallets(true);
    const item = providerList().find((provider) => provider.key === select.value);
    if (!item) throw new Error("No wallet provider is available. Use a browser profile with the wallet extension enabled for this site.");
    return item;
  };

  const requireMainnet = async (api) => {
    if (typeof api.getNetworkId !== "function" || (await api.getNetworkId()) !== NETWORK_ID) throw new Error("Connected wallet is not on Cardano Mainnet.");
  };

  const run = (button, action, stage) => async () => {
    button.disabled = true;
    try { await action(); }
    catch (error) { const message = describeError(error); log(message, "error"); if (stage) setState(stage, "Error", "error"); }
    finally { button.disabled = false; updateActions(); }
  };

  const loadNetwork = async () => {
    try {
      const network = await fetchJson("/api/network");
      if (network.networkId !== NETWORK_ID) throw new Error("Local server returned the wrong network.");
      state.network = network;
      const parent = elements.networkState.parentElement;
      parent.className = "network-state ok";
      elements.networkState.textContent = `Mainnet epoch ${network.epoch}`;
      log(`Loaded Mainnet protocol parameters at epoch ${network.epoch}.`, "ok");
    } catch (error) {
      elements.networkState.parentElement.className = "network-state error";
      elements.networkState.textContent = "Mainnet lookup unavailable";
      log(`Could not load Mainnet protocol parameters: ${describeError(error)}`, "error");
    }
    updateActions();
  };

  elements.addProposal.addEventListener("click", () => addRow());
  elements.refreshWallets.addEventListener("click", () => refreshWallets());
  elements.clearLog.addEventListener("click", () => { elements.statusLog.textContent = ""; });
  elements.resetTransaction.addEventListener("click", invalidateTransaction);

  elements.validateProposals.addEventListener("click", run(elements.validateProposals, async () => {
    const actions = collectActions(false);
    log(`Validating ${actions.length} governance action${actions.length === 1 ? "" : "s"} against Mainnet.`);
    const result = await fetchJson("/api/validate-proposals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions }),
    });
    state.validatedKeys.clear();
    const byKey = new Map(result.proposals.map((proposal) => [`${proposal.txHash}#${proposal.index}`, proposal]));
    for (const row of proposalRows()) {
      const action = parseGovernanceAction(row.querySelector(".proposal-input").value);
      const proposal = byKey.get(action.key);
      const status = row.querySelector(".proposal-status");
      if (!proposal?.found) { status.textContent = "Not found on Mainnet"; status.className = "proposal-status error"; continue; }
      if (!proposal.open) { status.textContent = `Not open (expiration epoch ${proposal.expirationEpoch})`; status.className = "proposal-status error"; continue; }
      status.textContent = `${proposal.proposalType} / open through epoch ${proposal.expirationEpoch}`;
      status.className = "proposal-status ok";
      state.validatedKeys.add(action.key);
    }
    if (state.validatedKeys.size !== actions.length) throw new Error("Every governance action must exist and remain open before signing.");
    elements.proposalSummary.textContent = `${actions.length} proposal${actions.length === 1 ? "" : "s"} validated at epoch ${result.currentEpoch}`;
    log("All governance actions are open and ready for vote selection.", "ok");
  }));

  elements.connectFee.addEventListener("click", run(elements.connectFee, async () => {
    const selected = selectedProvider(elements.feeWallet);
    log(`Calling window.cardano.${selected.key}.enable() for the fee payer.`);
    const api = await selected.provider.enable();
    await requireMainnet(api);
    state.feeApi = api;
    setState(elements.feeState, "Connected", "ok");
    log(`${selected.name} connected as fee payer on Mainnet.`, "ok");
    if (elements.feeWallet.value === elements.drepWallet.value) log("Both roles use the same provider. Account switching may require reconnecting each role before signing.", "warn");
  }, elements.feeState));

  elements.connectDrep.addEventListener("click", run(elements.connectDrep, async () => {
    const selected = selectedProvider(elements.drepWallet);
    log(`Requesting CIP-95 from ${selected.name}.`);
    const api = await selected.provider.enable({ extensions: [{ cip: 95 }] });
    await requireMainnet(api);
    if (!api.cip95 || typeof api.cip95.getPubDRepKey !== "function") throw new Error("Selected wallet does not expose api.cip95.getPubDRepKey().");
    const publicKey = normalizeHex(await api.cip95.getPubDRepKey());
    if (publicKey.length !== 64) throw new Error("Wallet returned a malformed DRep public key.");
    const keyHash = bytesToHex(blake2b(hexToBytes(publicKey), 28));
    if (state.unsignedTx && keyHash !== state.plan?.drepKeyHash) {
      throw new Error("This locked transaction was built for a different DRep key. Reset the transaction before changing DRep accounts.");
    }
    const drepId = drepIdFromHash(keyHash);
    const registration = await fetchJson("/api/validate-drep", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ drepId, keyHash }),
    });
    if (!registration.found || !registration.registered) throw new Error(`${drepId} is not currently registered on Mainnet.`);
    if (!registration.active) throw new Error(`${drepId} is registered but not active on Mainnet.`);
    state.drepApi = api; state.drepPublicKey = publicKey; state.drepKeyHash = keyHash;
    elements.drepId.textContent = drepId;
    setState(elements.drepState, "Verified", "ok");
    log(`Connected active key-based DRep ${drepId}; registration expires at epoch ${registration.expiresEpoch}.`, "ok");
  }, elements.drepState));

  elements.signFee.addEventListener("click", run(elements.signFee, async () => {
    if (!state.network || !state.feeApi || !state.drepKeyHash) throw new Error("Validate proposals and connect both signing roles first.");
    const actions = collectActions(true);
    if (actions.some((action) => !state.validatedKeys.has(action.key))) throw new Error("Proposal inputs changed after validation.");
    const rawUtxos = (await state.feeApi.getUtxos()) || [];
    if (!rawUtxos.length) throw new Error("Fee wallet returned no UTxOs.");
    const parsed = [];
    for (const raw of rawUtxos) {
      try { parsed.push(parseWalletUtxo(unwrapWalletHex(raw, "Wallet UTxO"))); }
      catch (error) { log(`Skipped unsupported UTxO: ${describeError(error)}`, "warn"); }
    }
    if (!parsed.length) throw new Error("Fee wallet has no supported key-controlled UTxOs.");
    if (typeof state.feeApi.getChangeAddress !== "function") throw new Error("Fee wallet does not expose the required CIP-30 getChangeAddress() method.");
    const changeAddress = hexToBytes(unwrapWalletHex(await state.feeApi.getChangeAddress(), "Fee-wallet change address"));
    const changeAddressType = changeAddress.length ? changeAddress[0] >> 4 : -1;
    if (changeAddress.length < 29 || changeAddressType < 0 || changeAddressType > 7 || (changeAddress[0] & 0x0f) !== NETWORK_ID) {
      throw new Error("Fee wallet returned an unsupported or non-Mainnet change address.");
    }
    const plan = choosePlan(parsed, actions, state.drepKeyHash, changeAddress, state.network);
    const txHex = bytesToHex(plan.transaction);
    log(`Built ${actions.length}-vote transaction using ${plan.inputs.length} fee-wallet input${plan.inputs.length === 1 ? "" : "s"}. Change is locked to the fee wallet's CIP-30 change address.`);
    const witnessHex = unwrapWalletHex(await state.feeApi.signTx(txHex, true), "Fee-wallet signTx result");
    await verifyWitnessSet(witnessHex, plan.paymentHashes, txHex, "Fee wallet");
    state.plan = plan; state.unsignedTx = txHex; state.bodyHash = bytesToHex(blake2b(plan.body, 32)); state.feeWitness = witnessHex;
    for (const control of elements.proposalRows.querySelectorAll("input, .vote-control button, .remove-proposal")) control.disabled = true;
    elements.summaryVotes.textContent = String(actions.length);
    elements.summaryInputs.textContent = String(plan.inputs.length);
    elements.summaryFee.textContent = `${formatAda(plan.fee)} ADA`;
    elements.summaryChange.textContent = `${formatAda(plan.change)} ADA`;
    elements.summaryHash.textContent = state.bodyHash;
    elements.txSummary.hidden = false;
    setState(elements.feeState, "Signed", "ok");
    log(`Fee witness verified. Transaction body locked at ${state.bodyHash}.`, "ok");
  }, elements.feeState));

  elements.signDrepSubmit.addEventListener("click", run(elements.signDrepSubmit, async () => {
    if (!state.drepApi || !state.unsignedTx || !state.feeWitness || !state.plan) throw new Error("Build and fee-sign the transaction first.");
    const currentPublicKey = normalizeHex(await state.drepApi.cip95.getPubDRepKey());
    const currentHash = bytesToHex(blake2b(hexToBytes(currentPublicKey), 28));
    if (currentHash !== state.drepKeyHash) throw new Error("DRep wallet account changed. Reconnect the DRep role and rebuild the transaction.");
    log("Requesting the DRep voting witness for the locked transaction body.");
    const drepWitness = unwrapWalletHex(await state.drepApi.signTx(state.unsignedTx, true), "DRep signTx result");
    const drepWitnesses = await verifyWitnessSet(drepWitness, [state.drepKeyHash], state.unsignedTx, "DRep wallet");
    if (drepWitnesses.some((witness) => witness.keyHash !== state.drepKeyHash)) {
      throw new Error("DRep wallet returned a witness other than the selected DRep credential.");
    }
    const finalTx = assembleTransaction(state.unsignedTx, state.feeWitness, drepWitness);
    const finalBytes = hexToBytes(finalTx);
    const minimumFee = BigInt(state.network.txFeeFixed) + BigInt(state.network.txFeePerByte) * BigInt(finalBytes.length);
    if (state.plan.fee < minimumFee) throw new Error(`Final witnesses require at least ${formatAda(minimumFee)} ADA in fees. Reset and rebuild.`);
    if (finalBytes.length > state.network.maxTxSize) throw new Error("Final transaction exceeds the current maximum transaction size.");
    if (typeof state.feeApi?.submitTx !== "function") throw new Error("Fee wallet does not expose submitTx().");
    log("Payment and DRep witnesses verified. Submitting through the fee wallet.");
    const submittedHash = normalizeHex(await state.feeApi.submitTx(finalTx));
    if (submittedHash !== state.bodyHash) throw new Error(`Wallet returned unexpected transaction hash ${submittedHash}.`);
    elements.submittedTx.textContent = submittedHash;
    elements.submittedTx.href = `https://adastat.net/transactions/${submittedHash}`;
    elements.submission.hidden = false;
    state.submitted = true;
    setState(elements.drepState, "Submitted", "ok");
    log(`Submitted ${submittedHash}.`, "ok");
  }, elements.drepState));

  addRow();
  refreshWallets(true);
  setTimeout(() => refreshWallets(true), 300);
  setTimeout(() => refreshWallets(), 1200);
  loadNetwork();
}

bootstrap();
