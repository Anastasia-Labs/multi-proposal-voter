import { ApiError, handleError, koiosJson, readJsonBody, requireMethod, sendJson } from "../lib/api.js";

const TX_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ACTIONS = 20;
const PROPOSAL_SELECT = [
  "proposal_id", "proposal_tx_hash", "proposal_index", "proposal_type", "proposed_epoch", "expiration",
  "ratified_epoch", "enacted_epoch", "dropped_epoch", "expired_epoch",
].join(",");

export function normalizeActions(payload) {
  if (!Array.isArray(payload?.actions) || payload.actions.length < 1 || payload.actions.length > MAX_ACTIONS) {
    throw new ApiError(400, `Provide between 1 and ${MAX_ACTIONS} governance actions.`);
  }
  const seen = new Set();
  return payload.actions.map((action) => {
    const txHash = typeof action?.txHash === "string" ? action.txHash.toLowerCase() : "";
    const index = action?.index;
    if (!TX_HASH_RE.test(txHash) || !Number.isInteger(index) || index < 0 || index > 65_535) {
      throw new ApiError(400, "Each action needs a 64-character transaction hash and index from 0 to 65535.");
    }
    const key = `${txHash}#${index}`;
    if (seen.has(key)) throw new ApiError(400, `Duplicate governance action: ${key}.`);
    seen.add(key);
    return { txHash, index };
  });
}

export async function validateProposals(payload, fetchImpl = globalThis.fetch) {
  const actions = normalizeActions(payload);
  const tipRows = await koiosJson("tip", { fetchImpl });
  const currentEpoch = Number(Array.isArray(tipRows) ? tipRows[0]?.epoch_no : NaN);
  if (!Number.isSafeInteger(currentEpoch)) throw new ApiError(502, "Koios returned malformed chain tip data.");

  const proposals = await Promise.all(actions.map(async ({ txHash, index }) => {
    const query = new URLSearchParams({
      proposal_tx_hash: `eq.${txHash}`,
      proposal_index: `eq.${index}`,
      select: PROPOSAL_SELECT,
    });
    const rows = await koiosJson(`proposal_list?${query}`, { fetchImpl });
    const proposal = Array.isArray(rows) ? rows[0] : undefined;
    if (!proposal) return { txHash, index, found: false, open: false };
    const expiration = Number(proposal.expiration);
    if (!Number.isSafeInteger(expiration)) throw new ApiError(502, "Koios returned malformed proposal data.");
    const terminal = ["ratified_epoch", "enacted_epoch", "dropped_epoch", "expired_epoch"]
      .some((field) => proposal[field] !== null && proposal[field] !== undefined);
    return {
      txHash,
      index,
      found: true,
      open: !terminal && currentEpoch <= expiration,
      proposalId: proposal.proposal_id,
      proposalType: proposal.proposal_type,
      proposedEpoch: proposal.proposed_epoch,
      expirationEpoch: expiration,
      currentEpoch,
      ratifiedEpoch: proposal.ratified_epoch,
      enactedEpoch: proposal.enacted_epoch,
      droppedEpoch: proposal.dropped_epoch,
      expiredEpoch: proposal.expired_epoch,
    };
  }));
  return { currentEpoch, proposals };
}

export default async function handler(request, response) {
  try {
    requireMethod(request, "POST");
    sendJson(response, 200, await validateProposals(await readJsonBody(request)));
  } catch (error) {
    handleError(response, error);
  }
}
