import { ApiError, handleError, koiosJson, requireMethod, sendJson } from "../lib/api.js";

export async function getNetwork(fetchImpl = globalThis.fetch) {
  const [params, tipRows] = await Promise.all([
    koiosJson("cli_protocol_params", { fetchImpl }),
    koiosJson("tip", { fetchImpl }),
  ]);
  const tip = Array.isArray(tipRows) ? tipRows[0] : undefined;
  const required = ["txFeePerByte", "txFeeFixed", "utxoCostPerByte", "maxTxSize"];
  const tipRequired = ["epoch_no", "abs_slot", "block_time"];
  if (
    !tip
    || !required.every((key) => Number.isSafeInteger(Number(params?.[key])))
    || !tipRequired.every((key) => Number.isSafeInteger(Number(tip[key])))
  ) {
    throw new ApiError(502, "Koios returned malformed protocol parameters or chain tip data.");
  }
  return {
    networkId: 1,
    epoch: Number(tip.epoch_no),
    absoluteSlot: Number(tip.abs_slot),
    blockTime: Number(tip.block_time),
    txFeePerByte: Number(params.txFeePerByte),
    txFeeFixed: Number(params.txFeeFixed),
    utxoCostPerByte: Number(params.utxoCostPerByte),
    maxTxSize: Number(params.maxTxSize),
  };
}

export default async function handler(request, response) {
  try {
    requireMethod(request, "GET");
    sendJson(response, 200, await getNetwork());
  } catch (error) {
    handleError(response, error);
  }
}
