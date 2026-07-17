import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadTransactionInternals() {
  const source = (await readFile(new URL("../app.js", import.meta.url), "utf8"))
    .replace(/\nbootstrap\(\);\s*$/, "\n")
    .concat(`
      globalThis.__internals = {
        buildTransaction, byteStringPayload, bytesToHex, decodeUnsigned,
        encodeArray, encodeBytes, encodeUInt, hexToBytes, readArrayItems,
        readMapEntries, unwrapTags,
      };
    `);
  const context = vm.createContext({ URL, Uint8Array });
  vm.runInContext(source, context);
  return context.__internals;
}

function mapValue(internals, mapBytes, key) {
  const entry = internals.readMapEntries(mapBytes)
    .find((candidate) => internals.decodeUnsigned(candidate.keyRaw) === BigInt(key));
  assert.ok(entry, `CBOR map key ${key} should exist`);
  return entry.valueRaw;
}

test("one transaction carries multiple votes and returns all change to the fee address", async () => {
  const cbor = await loadTransactionInternals();
  const feeInputHash = "11".repeat(32);
  const feeInput = cbor.encodeArray([cbor.encodeBytes(cbor.hexToBytes(feeInputHash)), cbor.encodeUInt(7)]);
  const feeChangeAddress = new Uint8Array(57).fill(0xa5);
  feeChangeAddress[0] = 0x01;
  const drepKeyHash = "d4".repeat(28);
  const actions = [
    { txHash: "aa".repeat(32), index: 0, vote: "yes" },
    { txHash: "bb".repeat(32), index: 1, vote: "no" },
    { txHash: "cc".repeat(32), index: 2, vote: "abstain" },
  ];

  const built = cbor.buildTransaction(
    [{ inputRaw: feeInput }],
    3_000_000n,
    null,
    actions,
    drepKeyHash,
    feeChangeAddress,
    200_000n,
  );

  const body = cbor.readArrayItems(built.transaction)[0];
  const inputSet = cbor.readArrayItems(cbor.unwrapTags(mapValue(cbor, body, 0)));
  assert.equal(inputSet.length, 1);
  assert.equal(cbor.bytesToHex(inputSet[0]), cbor.bytesToHex(feeInput));

  const outputs = cbor.readArrayItems(mapValue(cbor, body, 1));
  assert.equal(outputs.length, 1);
  const outputItems = cbor.readArrayItems(outputs[0]);
  assert.equal(cbor.bytesToHex(cbor.byteStringPayload(outputItems[0])), cbor.bytesToHex(feeChangeAddress));
  assert.equal(cbor.decodeUnsigned(outputItems[1]), 2_800_000n);

  const votingProcedures = mapValue(cbor, body, 19);
  const voters = cbor.readMapEntries(votingProcedures);
  assert.equal(voters.length, 1);
  const voter = cbor.readArrayItems(voters[0].keyRaw);
  assert.equal(cbor.decodeUnsigned(voter[0]), 2n);
  assert.equal(cbor.bytesToHex(cbor.byteStringPayload(voter[1])), drepKeyHash);
  const votes = cbor.readMapEntries(voters[0].valueRaw);
  assert.equal(votes.length, 3);
  const voteCodes = Array.from(votes, (entry) => cbor.decodeUnsigned(cbor.readArrayItems(entry.valueRaw)[0])).sort();
  assert.deepEqual(voteCodes, [0n, 1n, 2n]);
});

test("browser role calls keep funds and submission on the fee wallet", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /state\.feeApi\.getUtxos\(\)/);
  assert.match(source, /state\.feeApi\.getChangeAddress\(\)/);
  assert.match(source, /state\.feeApi\.submitTx\(finalTx\)/);
  assert.doesNotMatch(source, /state\.drepApi\.(?:getUtxos|getChangeAddress|submitTx)\(/);
  assert.match(source, /witness\.keyHash !== state\.drepKeyHash/);
});
