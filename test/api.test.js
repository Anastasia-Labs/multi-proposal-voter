import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../lib/api.js";
import { getEpochParameters } from "../api/koios/epoch_params.js";
import { getNetwork } from "../api/network.js";
import { normalizeDrep, validateDrep } from "../api/validate-drep.js";
import { normalizeActions, validateProposals } from "../api/validate-proposals.js";

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("proposal input is bounded, normalized, and duplicate-free", () => {
  const hash = "AB".repeat(32);
  assert.deepEqual(normalizeActions({ actions: [{ txHash: hash, index: 2 }] }), [
    { txHash: hash.toLowerCase(), index: 2 },
  ]);
  assert.throws(
    () => normalizeActions({ actions: [{ txHash: hash, index: 2 }, { txHash: hash, index: 2 }] }),
    (error) => error instanceof ApiError && error.status === 400 && /Duplicate/.test(error.message),
  );
  assert.throws(() => normalizeActions({ actions: Array.from({ length: 21 }, () => ({ txHash: hash, index: 0 })) }), ApiError);
});

test("proposal validation reports open and terminal governance actions", async () => {
  const openHash = "aa".repeat(32);
  const closedHash = "bb".repeat(32);
  const fetchImpl = async (url) => {
    if (url.endsWith("/tip")) return jsonResponse([{ epoch_no: 500 }]);
    const parsed = new URL(url);
    const txHash = parsed.searchParams.get("proposal_tx_hash").slice(3);
    return jsonResponse([{
      proposal_id: `${txHash}00`,
      proposal_type: "InfoAction",
      proposed_epoch: 499,
      expiration: 510,
      ratified_epoch: txHash === closedHash ? 500 : null,
      enacted_epoch: null,
      dropped_epoch: null,
      expired_epoch: null,
    }]);
  };
  const result = await validateProposals({
    actions: [{ txHash: openHash, index: 0 }, { txHash: closedHash, index: 1 }],
  }, fetchImpl);
  assert.equal(result.currentEpoch, 500);
  assert.equal(result.proposals[0].open, true);
  assert.equal(result.proposals[1].open, false);
});

test("network endpoint accepts only complete integer protocol data", async () => {
  const fetchImpl = async (url) => url.endsWith("/tip")
    ? jsonResponse([{ epoch_no: 500, abs_slot: 140_000_000, block_time: 1_800_000_000 }])
    : jsonResponse({ txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, maxTxSize: 16384 });
  assert.deepEqual(await getNetwork(fetchImpl), {
    networkId: 1,
    epoch: 500,
    absoluteSlot: 140_000_000,
    blockTime: 1_800_000_000,
    txFeePerByte: 44,
    txFeeFixed: 155381,
    utxoCostPerByte: 4310,
    maxTxSize: 16384,
  });
});

test("Lucid epoch parameters are fetched only through the fixed Koios route", async () => {
  const params = {
    min_fee_a: 44,
    min_fee_b: 155381,
    max_tx_size: 16384,
    max_val_size: 5000,
    key_deposit: "2000000",
    pool_deposit: "500000000",
    drep_deposit: "500000000",
    gov_action_deposit: "100000000000",
    price_mem: 0.0577,
    price_step: 0.0000721,
    max_tx_ex_mem: 16500000,
    max_tx_ex_steps: 10000000000,
    coins_per_utxo_size: "4310",
    collateral_percent: 150,
    max_collateral_inputs: 3,
    min_fee_ref_script_cost_per_byte: 15,
    cost_models: { PlutusV1: [], PlutusV2: [], PlutusV3: [] },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.koios.rest/api/v1/epoch_params?limit=1");
    assert.equal(options.method, "GET");
    return jsonResponse([params]);
  };
  assert.deepEqual(await getEpochParameters(fetchImpl), [params]);
});

test("DRep validation binds the CIP-129 ID to the connected key hash", async () => {
  const keyHash = "47".repeat(28);
  const drepId = `drep1${"q".repeat(40)}`;
  assert.deepEqual(normalizeDrep({ drepId: drepId.toUpperCase(), keyHash: keyHash.toUpperCase() }), { drepId, keyHash });
  const fetchImpl = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { _drep_ids: [drepId] });
    return jsonResponse([{
      drep_id: drepId,
      hex: keyHash,
      has_script: false,
      drep_status: "registered",
      active: true,
      expires_epoch_no: 550,
    }]);
  };
  assert.deepEqual(await validateDrep({ drepId, keyHash }, fetchImpl), {
    found: true,
    registered: true,
    active: true,
    status: "registered",
    expiresEpoch: 550,
  });
});
