import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../lib/api.js";
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
