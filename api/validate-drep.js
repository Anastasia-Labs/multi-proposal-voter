import { ApiError, handleError, koiosJson, readJsonBody, requireMethod, sendJson } from "../lib/api.js";

const DREP_HASH_RE = /^[0-9a-f]{56}$/;
const DREP_ID_RE = /^drep1[023456789acdefghjklmnpqrstuvwxyz]{20,100}$/;

export function normalizeDrep(payload) {
  const drepId = typeof payload?.drepId === "string" ? payload.drepId.toLowerCase() : "";
  const keyHash = typeof payload?.keyHash === "string" ? payload.keyHash.toLowerCase() : "";
  if (!DREP_ID_RE.test(drepId) || !DREP_HASH_RE.test(keyHash)) {
    throw new ApiError(400, "Provide a valid key-based CIP-129 DRep ID and key hash.");
  }
  return { drepId, keyHash };
}

export async function validateDrep(payload, fetchImpl = globalThis.fetch) {
  const { drepId, keyHash } = normalizeDrep(payload);
  const rows = await koiosJson("drep_info", { body: { _drep_ids: [drepId] }, fetchImpl });
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return { found: false, registered: false, active: false };
  if (row.hex !== keyHash || row.drep_id !== drepId || row.has_script !== false) {
    throw new ApiError(400, "Koios returned a DRep credential that does not match the connected key.");
  }
  return {
    found: true,
    registered: row.drep_status === "registered",
    active: row.active === true,
    status: row.drep_status,
    expiresEpoch: row.expires_epoch_no,
  };
}

export default async function handler(request, response) {
  try {
    requireMethod(request, "POST");
    sendJson(response, 200, await validateDrep(await readJsonBody(request)));
  } catch (error) {
    handleError(response, error);
  }
}
