import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CML,
  Emulator,
  Lucid,
  generateEmulatorAccount,
} from "@lucid-evolution/lucid";

import {
  assembleCanonicalTransaction,
  buildVotingTransaction,
  drepIdFromKeyHash,
  koiosProxyUrl,
  verifyWitnessSet,
} from "../src/transaction.js";

const ACTIONS = [
  { txHash: "aa".repeat(32), index: 0, vote: "yes" },
  { txHash: "bb".repeat(32), index: 1, vote: "no" },
  { txHash: "cc".repeat(32), index: 2, vote: "abstain" },
];

test("CIP-129 DRep ID encoding matches the known governance credential", () => {
  assert.equal(
    drepIdFromKeyHash("fdec0e7b970169151874a50e0f22f41fe95dd722eb0e1a11364095e2"),
    "drep1yt77crnmjuqkj9gcwjjsurez7s07jhwhyt4suxs3xeqftcsfrspun",
  );
});

test("browser Koios traffic uses the application's same-origin proxy", () => {
  assert.equal(
    koiosProxyUrl("https://multi-proposal-voter.vercel.app"),
    "https://multi-proposal-voter.vercel.app/api/koios",
  );
  assert.equal(koiosProxyUrl("http://127.0.0.1:8793"), "http://127.0.0.1:8793/api/koios");
  assert.throws(() => koiosProxyUrl("null"), /HTTP or HTTPS/);
});

async function makePlan() {
  const account = generateEmulatorAccount({ lovelace: 10_000_000n });
  const emulator = new Emulator([account]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);
  const changeAddress = await lucid.wallet().address();
  const feeUtxos = await lucid.wallet().getUtxos();
  const drepKey = CML.PrivateKey.generate_ed25519();
  const drepKeyHash = drepKey.to_public().hash().to_hex();
  const plan = await buildVotingTransaction({
    lucid,
    feeUtxos,
    changeAddress,
    actions: ACTIONS,
    drepKeyHash,
  });
  return { changeAddress, drepKey, drepKeyHash, emulator, plan };
}

test("Lucid builds one canonical transaction containing every selected DRep vote", async () => {
  const { changeAddress, drepKeyHash, plan } = await makePlan();
  const transaction = CML.Transaction.from_cbor_hex(plan.unsignedTx);
  const body = transaction.body();

  assert.equal(plan.unsignedTx, transaction.to_canonical_cbor_hex());
  assert.equal(body.to_cbor_hex(), body.to_canonical_cbor_hex());
  assert.equal(plan.inputCount, 1);
  assert.equal(plan.outputCount, 1);
  assert.equal(body.outputs().get(0).address().to_bech32(), changeAddress);
  assert.equal(plan.change + plan.fee, 10_000_000n);

  const procedures = body.voting_procedures();
  assert.equal(procedures.len(), 1);
  const voter = procedures.keys().get(0);
  assert.equal(voter.kind(), CML.VoterKind.DRepKeyHash);
  assert.equal(voter.as_d_rep_key_hash().to_hex(), drepKeyHash);
  const votes = procedures.get(voter);
  assert.equal(votes.len(), ACTIONS.length);

  const observed = new Map();
  const actionIds = votes.keys();
  for (let index = 0; index < actionIds.len(); index += 1) {
    const actionId = actionIds.get(index);
    observed.set(
      `${actionId.transaction_id().to_hex()}#${actionId.gov_action_index()}`,
      votes.get(actionId).vote(),
    );
  }
  assert.deepEqual(observed, new Map([
    [`${ACTIONS[0].txHash}#0`, CML.Vote.Yes],
    [`${ACTIONS[1].txHash}#1`, CML.Vote.No],
    [`${ACTIONS[2].txHash}#2`, CML.Vote.Abstain],
  ]));
});

test("Lucid assembles exact fee and DRep witnesses without changing the canonical body", async () => {
  const { drepKey, drepKeyHash, plan } = await makePlan();
  const feeWitness = await plan.txBuilder.partialSign.withWallet();
  verifyWitnessSet(feeWitness, plan.paymentHashes, plan.unsignedTx, "Fee wallet");

  const transaction = CML.Transaction.from_cbor_hex(plan.unsignedTx);
  const drepWitnessBuilder = CML.TransactionWitnessSetBuilder.new();
  drepWitnessBuilder.add_vkey(CML.make_vkey_witness(CML.hash_transaction(transaction.body()), drepKey));
  const drepWitness = drepWitnessBuilder.build().to_canonical_cbor_hex();
  verifyWitnessSet(drepWitness, [drepKeyHash], plan.unsignedTx, "DRep wallet");

  const assembled = await assembleCanonicalTransaction(
    plan,
    [feeWitness, drepWitness],
    [...plan.paymentHashes, drepKeyHash],
    { txFeePerByte: 44, txFeeFixed: 155_381, maxTxSize: 16_384 },
  );
  const finalTransaction = CML.Transaction.from_cbor_hex(assembled.finalTx);
  assert.equal(assembled.bodyHash, plan.bodyHash);
  assert.equal(assembled.finalTx, finalTransaction.to_canonical_cbor_hex());
  assert.equal(finalTransaction.witness_set().vkeywitnesses().len(), 2);
});

test("browser wallet calls keep all funds and submission on the fee role", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /state\.feeApi\.getChangeAddress\(\)/);
  assert.match(source, /state\.feeLucid\.wallet\(\)\.getUtxos\(\)/);
  assert.match(source, /state\.feeApi\.submitTx\(finalTx\)/);
  assert.doesNotMatch(source, /state\.drepApi\.(?:getUtxos|getChangeAddress|submitTx)\(/);
  assert.match(source, /state\.drepApi\.cip95\.getPubDRepKey\(\)/);
  assert.match(source, /state\.drepApi\.signTx\(state\.unsignedTx, true\)/);
});
