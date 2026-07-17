import { CML, Koios, Lucid, fromHex } from "@lucid-evolution/lucid";

const KOIOS_MAINNET = "https://api.koios.rest/api/v1";
const VOTE_CHOICES = Object.freeze({
  no: "No",
  yes: "Yes",
  abstain: "Abstain",
});

export function normalizeHex(value) {
  return String(value || "").trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
}

export function unwrapWalletHex(result, label) {
  const value = typeof result === "string" ? result : result?.cbor;
  const hex = normalizeHex(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`${label} is not valid hexadecimal data.`);
  }
  return hex;
}

export function parseGovernanceAction(value) {
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
    if (index > 65_535) throw new Error("Governance action index exceeds 65535.");
    return { txHash: hashIndex[1], index, key: `${hashIndex[1]}#${index}` };
  }
  if (!/^[0-9a-f]+$/.test(token) || token.length < 66 || token.length > 68 || token.length % 2 !== 0) {
    throw new Error("Use an AdaStat governance URL, governance action hex, or txHash#index.");
  }
  const txHash = token.slice(0, 64);
  const index = Number.parseInt(token.slice(64), 16);
  return { txHash, index, key: `${txHash}#${index}` };
}

export function drepKeyHashFromPublicKey(publicKeyHex) {
  const publicKey = normalizeHex(publicKeyHex);
  if (!/^[0-9a-f]{64}$/.test(publicKey)) throw new Error("Wallet returned a malformed DRep public key.");
  return CML.PublicKey.from_bytes(fromHex(publicKey)).hash().to_hex();
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
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
    while (bits >= 5) {
      bits -= 5;
      data.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) data.push((accumulator << (5 - bits)) & 31);
  const expanded = [...hrp].map((char) => char.charCodeAt(0) >>> 5)
    .concat([0], [...hrp].map((char) => char.charCodeAt(0) & 31));
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return `${hrp}1${[...data, ...checksum].map((value) => charset[value]).join("")}`;
}

export function drepIdFromKeyHash(keyHash) {
  const hash = normalizeHex(keyHash);
  if (!/^[0-9a-f]{56}$/.test(hash)) throw new Error("DRep key hash is malformed.");
  return bech32Encode("drep", Uint8Array.from([0x22, ...fromHex(hash)]));
}

export function feeChangeAddressFromHex(addressHex) {
  const address = CML.Address.from_hex(unwrapWalletHex(addressHex, "Fee-wallet change address"));
  if (address.network_id() !== 1) throw new Error("Fee wallet returned a non-Mainnet change address.");
  if (!address.payment_cred()?.as_pub_key()) {
    throw new Error("Fee wallet change address is not controlled by a payment key.");
  }
  return address.to_bech32();
}

export async function createFeeLucid(walletApi) {
  const lucid = await Lucid(new Koios(KOIOS_MAINNET), "Mainnet");
  lucid.selectWallet.fromAPI(walletApi);
  return lucid;
}

function outRef(txHash, index) {
  return `${txHash.toLowerCase()}#${BigInt(index)}`;
}

function paymentKeyHash(address) {
  return CML.Address.from_bech32(address).payment_cred()?.as_pub_key()?.to_hex();
}

function eligibleFeeUtxos(feeUtxos) {
  return feeUtxos.filter((utxo) => paymentKeyHash(utxo.address));
}

function assertNoUnintendedOperations(body) {
  const unexpected = [
    ["certificates", body.certs()],
    ["withdrawals", body.withdrawals()],
    ["minting", body.mint()],
    ["collateral inputs", body.collateral_inputs()],
    ["collateral return", body.collateral_return()],
    ["reference inputs", body.reference_inputs()],
    ["proposal procedures", body.proposal_procedures()],
    ["required signers", body.required_signers()],
    ["treasury donation", body.donation()],
    ["current treasury value", body.current_treasury_value()],
  ].find(([, value]) => value !== undefined);
  if (unexpected) throw new Error(`Lucid produced unexpected ${unexpected[0]}.`);
}

function inspectInputs(body, feeUtxos) {
  const allowed = new Map(feeUtxos.map((utxo) => [
    outRef(utxo.txHash, utxo.outputIndex),
    paymentKeyHash(utxo.address),
  ]));
  const inputs = body.inputs();
  const paymentHashes = new Set();
  for (let index = 0; index < inputs.len(); index += 1) {
    const input = inputs.get(index);
    const reference = outRef(input.transaction_id().to_hex(), input.index());
    const keyHash = allowed.get(reference);
    if (!keyHash) throw new Error(`Transaction input ${reference} did not come from the fee wallet.`);
    paymentHashes.add(keyHash);
  }
  if (inputs.len() === 0 || paymentHashes.size === 0) throw new Error("Lucid selected no fee-wallet inputs.");
  return { inputCount: inputs.len(), paymentHashes: [...paymentHashes] };
}

function inspectChange(body, changeAddress) {
  const expected = CML.Address.from_bech32(changeAddress).to_hex();
  const outputs = body.outputs();
  if (outputs.len() === 0) throw new Error("Lucid produced no fee-wallet change output.");
  let change = 0n;
  for (let index = 0; index < outputs.len(); index += 1) {
    const output = outputs.get(index);
    if (output.address().to_hex() !== expected) {
      throw new Error("Lucid produced an output that is not the fee-wallet change address.");
    }
    change += output.amount().coin();
  }
  return { outputCount: outputs.len(), change };
}

function inspectVotes(body, actions, drepKeyHash) {
  const procedures = body.voting_procedures();
  if (!procedures || procedures.len() !== 1) throw new Error("Transaction must contain exactly one DRep voter.");
  const voters = procedures.keys();
  const voter = voters.get(0);
  if (voter.kind() !== CML.VoterKind.DRepKeyHash || voter.as_d_rep_key_hash()?.to_hex() !== drepKeyHash) {
    throw new Error("Transaction voting procedures target an unexpected DRep credential.");
  }
  const votes = procedures.get(voter);
  if (!votes || votes.len() !== actions.length) throw new Error("Transaction vote count does not match the selected proposals.");
  const expected = new Map(actions.map((action) => [
    outRef(action.txHash, action.index),
    CML.Vote[VOTE_CHOICES[action.vote]],
  ]));
  const ids = votes.keys();
  for (let index = 0; index < ids.len(); index += 1) {
    const id = ids.get(index);
    const key = outRef(id.transaction_id().to_hex(), id.gov_action_index());
    const procedure = votes.get(id);
    if (!expected.has(key) || procedure?.vote() !== expected.get(key) || procedure.anchor()) {
      throw new Error(`Transaction contains an unexpected vote for ${key}.`);
    }
    expected.delete(key);
  }
  if (expected.size) throw new Error("Transaction is missing one or more selected votes.");
}

export async function buildVotingTransaction({ lucid, feeUtxos, changeAddress, actions, drepKeyHash }) {
  const usableUtxos = eligibleFeeUtxos(feeUtxos);
  if (usableUtxos.length === 0) throw new Error("Fee wallet has no payment-key-controlled UTxOs.");
  const seen = new Set();
  const builder = lucid.newTx();
  const voter = CML.Voter.new_d_rep_key_hash(CML.Ed25519KeyHash.from_hex(drepKeyHash));
  let voteBuilder = CML.VoteBuilder.new();
  for (const action of actions) {
    const key = outRef(action.txHash, action.index);
    if (seen.has(key)) throw new Error(`Duplicate governance action ${key}.`);
    if (!VOTE_CHOICES[action.vote]) throw new Error(`Invalid vote choice for ${key}.`);
    seen.add(key);
    const actionId = CML.GovActionId.new(
      CML.TransactionHash.from_hex(action.txHash),
      BigInt(action.index),
    );
    const procedure = CML.VotingProcedure.new(CML.Vote[VOTE_CHOICES[action.vote]]);
    voteBuilder = voteBuilder.with_vote(voter, actionId, procedure);
  }
  if (seen.size === 0) throw new Error("At least one governance vote is required.");

  // Lucid's public builder owns the transaction; its CML builder accepts the
  // complete same-voter map in one operation so multiple actions are retained.
  builder.rawConfig().txBuilder.add_vote(voteBuilder.build());

  const txBuilder = await builder.complete({
    canonical: true,
    changeAddress,
    coinSelection: true,
    includeLeftoverLovelaceAsFee: false,
    presetWalletInputs: usableUtxos,
  });
  const transaction = txBuilder.toTransaction();
  const body = transaction.body();
  assertNoUnintendedOperations(body);
  const inputPlan = inspectInputs(body, usableUtxos);
  const changePlan = inspectChange(body, changeAddress);
  inspectVotes(body, actions, drepKeyHash);

  const unsignedTx = normalizeHex(txBuilder.toCBOR({ canonical: true }));
  if (unsignedTx !== normalizeHex(transaction.to_canonical_cbor_hex())) {
    throw new Error("Lucid did not return canonical transaction CBOR.");
  }
  if (body.to_cbor_hex() !== body.to_canonical_cbor_hex()) {
    throw new Error("Lucid transaction body is not canonically encoded.");
  }

  return {
    txBuilder,
    unsignedTx,
    bodyHash: txBuilder.toHash(),
    fee: body.fee(),
    drepKeyHash,
    changeAddress,
    ...inputPlan,
    ...changePlan,
  };
}

function hasNonKeyWitnesses(witnessSet) {
  return Boolean(
    witnessSet.bootstrap_witnesses()
    || witnessSet.native_scripts()
    || witnessSet.plutus_v1_scripts()
    || witnessSet.plutus_v2_scripts()
    || witnessSet.plutus_v3_scripts()
    || witnessSet.plutus_datums()
    || witnessSet.redeemers(),
  );
}

export function verifyWitnessSet(witnessHex, expectedHashes, txHex, role) {
  const witnessSet = CML.TransactionWitnessSet.from_cbor_hex(unwrapWalletHex(witnessHex, `${role} witness set`));
  if (hasNonKeyWitnesses(witnessSet)) throw new Error(`${role} returned an unexpected non-key witness.`);
  const vkeys = witnessSet.vkeywitnesses();
  const transaction = CML.Transaction.from_cbor_hex(normalizeHex(txHex));
  const message = CML.hash_transaction(transaction.body()).to_raw_bytes();
  const actual = [];
  for (let index = 0; index < (vkeys?.len() || 0); index += 1) {
    const witness = vkeys.get(index);
    const publicKey = witness.vkey();
    const keyHash = publicKey.hash().to_hex();
    if (!publicKey.verify(message, witness.ed25519_signature())) {
      throw new Error(`${role} returned an invalid Ed25519 signature.`);
    }
    actual.push(keyHash);
  }
  const expected = [...new Set(expectedHashes.map(normalizeHex))].sort();
  const received = [...new Set(actual)].sort();
  if (actual.length !== received.length || expected.length !== received.length || expected.some((hash, index) => hash !== received[index])) {
    throw new Error(`${role} returned witnesses for unexpected credentials.`);
  }
  return received;
}

export async function assembleCanonicalTransaction(plan, witnesses, expectedHashes, network) {
  const signed = await plan.txBuilder.assemble(witnesses).complete();
  const finalTx = normalizeHex(signed.toCBOR({ canonical: true }));
  const transaction = CML.Transaction.from_cbor_hex(finalTx);
  if (finalTx !== normalizeHex(transaction.to_canonical_cbor_hex())) {
    throw new Error("Final transaction is not canonically encoded.");
  }
  const bodyHash = CML.hash_transaction(transaction.body()).to_hex();
  if (bodyHash !== plan.bodyHash) throw new Error("Transaction body changed while assembling witnesses.");
  verifyWitnessSet(transaction.witness_set().to_canonical_cbor_hex(), expectedHashes, finalTx, "Final transaction");
  const linearFee = CML.LinearFee.new(BigInt(network.txFeePerByte), BigInt(network.txFeeFixed), 0n);
  const minimumFee = CML.min_no_script_fee(transaction, linearFee);
  if (transaction.body().fee() < minimumFee) throw new Error("Final transaction fee is below the ledger minimum.");
  if (finalTx.length / 2 > network.maxTxSize) throw new Error("Final transaction exceeds the current maximum transaction size.");
  return { finalTx, bodyHash, minimumFee };
}

export function formatAda(lovelace) {
  const value = BigInt(lovelace);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
