import { ApiError, handleError, koiosJson, requireMethod, sendJson } from "../../lib/api.js";

export async function getEpochParameters(fetchImpl = globalThis.fetch) {
  const rows = await koiosJson("epoch_params?limit=1", { fetchImpl });
  const params = Array.isArray(rows) ? rows[0] : undefined;
  const required = [
    "min_fee_a", "min_fee_b", "max_tx_size", "max_val_size", "key_deposit", "pool_deposit",
    "drep_deposit", "gov_action_deposit", "price_mem", "price_step", "max_tx_ex_mem",
    "max_tx_ex_steps", "coins_per_utxo_size", "collateral_percent", "max_collateral_inputs",
    "min_fee_ref_script_cost_per_byte", "cost_models",
  ];
  if (!params || !required.every((key) => params[key] !== null && params[key] !== undefined)) {
    throw new ApiError(502, "Koios returned malformed epoch parameters.");
  }
  return [params];
}

export default async function handler(request, response) {
  try {
    requireMethod(request, "GET");
    sendJson(response, 200, await getEpochParameters());
  } catch (error) {
    handleError(response, error);
  }
}
