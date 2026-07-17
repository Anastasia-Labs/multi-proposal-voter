import {
  assembleCanonicalTransaction,
  buildVotingTransaction,
  createFeeLucid,
  drepIdFromKeyHash,
  drepKeyHashFromPublicKey,
  feeChangeAddressFromHex,
  formatAda,
  normalizeHex,
  parseGovernanceAction,
  unwrapWalletHex,
  verifyWitnessSet,
} from "./src/transaction.js";

const NETWORK_ID = 1;
const MAX_PROPOSALS = 20;

const state = {
  network: null,
  feeApi: null,
  feeLucid: null,
  feeChangeHex: "",
  drepApi: null,
  drepKeyHash: "",
  validatedKeys: new Set(),
  unsignedTx: "",
  feeWitness: "",
  plan: null,
  submitted: false,
};

function providerList() {
  if (!window.cardano || typeof window.cardano !== "object") return [];
  return Object.entries(window.cardano)
    .filter(([, provider]) => provider && typeof provider.enable === "function")
    .map(([key, provider]) => ({ key, provider, name: provider.name || key }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function describeError(error) {
  if (!error) return "Unknown error.";
  return [error.code !== undefined ? `code ${error.code}` : "", error.info || "", error.message || ""]
    .filter(Boolean).join(": ") || String(error);
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
  const setState = (element, text, kind = "") => {
    element.textContent = text;
    element.className = `state ${kind}`.trim();
  };
  const proposalRows = () => Array.from(elements.proposalRows.querySelectorAll(".proposal-row"));

  const updateActions = () => {
    let votesReady = proposalRows().length > 0;
    for (const row of proposalRows()) votesReady &&= Boolean(row.dataset.vote);
    elements.signFee.disabled = !(
      state.network && state.feeApi && state.feeLucid && state.drepKeyHash
      && state.validatedKeys.size === proposalRows().length && votesReady && !state.unsignedTx
    );
    elements.signDrepSubmit.disabled = !(state.unsignedTx && state.feeWitness && state.drepApi && !state.submitted);
    elements.resetTransaction.disabled = !state.unsignedTx;
  };

  const invalidateTransaction = () => {
    if (!state.unsignedTx) return;
    state.unsignedTx = "";
    state.feeWitness = "";
    state.plan = null;
    state.submitted = false;
    elements.txSummary.hidden = true;
    elements.submission.hidden = true;
    for (const control of elements.proposalRows.querySelectorAll("input, .vote-control button, .remove-proposal")) {
      control.disabled = false;
    }
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
    if (proposalRows().length >= MAX_PROPOSALS) {
      log(`A maximum of ${MAX_PROPOSALS} proposals is supported.`, "error");
      return;
    }
    const row = elements.proposalTemplate.content.firstElementChild.cloneNode(true);
    const input = row.querySelector(".proposal-input");
    const status = row.querySelector(".proposal-status");
    input.value = initialValue;
    input.addEventListener("input", () => {
      status.textContent = "";
      status.className = "proposal-status";
      invalidateValidation();
    });
    for (const button of row.querySelectorAll("[data-vote]")) {
      button.addEventListener("click", () => {
        row.dataset.vote = button.dataset.vote;
        for (const peer of row.querySelectorAll("[data-vote]")) peer.classList.toggle("selected", peer === button);
        invalidateTransaction();
        updateActions();
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
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No CIP-30 wallet detected";
        select.append(option);
      } else {
        for (const item of providers) {
          const option = document.createElement("option");
          option.value = item.key;
          option.textContent = item.name;
          select.append(option);
        }
        if (providers.some((item) => item.key === previous)) select.value = previous;
      }
    }
    if (!quiet) {
      const message = providers.length
        ? `Detected ${providers.length} wallet provider${providers.length === 1 ? "" : "s"}.`
        : "No window.cardano provider detected in this browser profile.";
      log(message, providers.length ? "ok" : "warn");
    }
  };

  const selectedProvider = (select) => {
    refreshWallets(true);
    const item = providerList().find((provider) => provider.key === select.value);
    if (!item) throw new Error("No wallet provider is available. Enable the wallet extension for this site and refresh.");
    return item;
  };

  const requireMainnet = async (api) => {
    if (typeof api.getNetworkId !== "function" || (await api.getNetworkId()) !== NETWORK_ID) {
      throw new Error("Connected wallet is not on Cardano Mainnet.");
    }
  };

  const run = (button, action, stage) => async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      log(describeError(error), "error");
      if (stage) setState(stage, "Error", "error");
    } finally {
      button.disabled = false;
      updateActions();
    }
  };

  const loadNetwork = async () => {
    try {
      const network = await fetchJson("/api/network");
      if (network.networkId !== NETWORK_ID) throw new Error("Server returned the wrong network.");
      state.network = network;
      elements.networkState.parentElement.className = "network-state ok";
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    state.validatedKeys.clear();
    const byKey = new Map(result.proposals.map((proposal) => [`${proposal.txHash}#${proposal.index}`, proposal]));
    for (const row of proposalRows()) {
      const action = parseGovernanceAction(row.querySelector(".proposal-input").value);
      const proposal = byKey.get(action.key);
      const status = row.querySelector(".proposal-status");
      if (!proposal?.found) {
        status.textContent = "Not found on Mainnet";
        status.className = "proposal-status error";
        continue;
      }
      if (!proposal.open) {
        status.textContent = `Not open (expiration epoch ${proposal.expirationEpoch})`;
        status.className = "proposal-status error";
        continue;
      }
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
    if (typeof api.getChangeAddress !== "function") throw new Error("Fee wallet does not expose getChangeAddress().");
    const changeHex = unwrapWalletHex(await api.getChangeAddress(), "Fee-wallet change address");
    feeChangeAddressFromHex(changeHex);
    const lucid = await createFeeLucid(api);
    state.feeApi = api;
    state.feeLucid = lucid;
    state.feeChangeHex = changeHex;
    setState(elements.feeState, "Connected", "ok");
    log(`${selected.name} connected as fee payer. Lucid Evolution loaded Mainnet parameters.`, "ok");
    if (elements.feeWallet.value === elements.drepWallet.value) {
      log("Both roles use one provider. Reconnect the fee role after account switching and before building.", "warn");
    }
  }, elements.feeState));

  elements.connectDrep.addEventListener("click", run(elements.connectDrep, async () => {
    const selected = selectedProvider(elements.drepWallet);
    log(`Requesting CIP-95 from ${selected.name}.`);
    const api = await selected.provider.enable({ extensions: [{ cip: 95 }] });
    await requireMainnet(api);
    if (!api.cip95 || typeof api.cip95.getPubDRepKey !== "function") {
      throw new Error("Selected wallet does not expose api.cip95.getPubDRepKey().");
    }
    const publicKey = normalizeHex(await api.cip95.getPubDRepKey());
    const keyHash = drepKeyHashFromPublicKey(publicKey);
    if (state.unsignedTx && keyHash !== state.plan?.drepKeyHash) {
      throw new Error("This locked transaction was built for a different DRep key. Reset before changing DRep accounts.");
    }
    const drepId = drepIdFromKeyHash(keyHash);
    const registration = await fetchJson("/api/validate-drep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drepId, keyHash }),
    });
    if (!registration.found || !registration.registered) throw new Error(`${drepId} is not currently registered on Mainnet.`);
    if (!registration.active) throw new Error(`${drepId} is registered but not active on Mainnet.`);
    state.drepApi = api;
    state.drepKeyHash = keyHash;
    elements.drepId.textContent = drepId;
    setState(elements.drepState, "Verified", "ok");
    log(`Connected active key-based DRep ${drepId}; registration expires at epoch ${registration.expiresEpoch}.`, "ok");
  }, elements.drepState));

  elements.signFee.addEventListener("click", run(elements.signFee, async () => {
    if (!state.network || !state.feeApi || !state.feeLucid || !state.drepKeyHash) {
      throw new Error("Validate proposals and connect both signing roles first.");
    }
    const actions = collectActions(true);
    if (actions.some((action) => !state.validatedKeys.has(action.key))) throw new Error("Proposal inputs changed after validation.");
    const currentChangeHex = unwrapWalletHex(await state.feeApi.getChangeAddress(), "Fee-wallet change address");
    if (currentChangeHex !== state.feeChangeHex) throw new Error("Fee-wallet account changed. Reconnect the fee wallet before building.");
    const changeAddress = feeChangeAddressFromHex(currentChangeHex);
    const feeUtxos = await state.feeLucid.wallet().getUtxos();
    const plan = await buildVotingTransaction({
      lucid: state.feeLucid,
      feeUtxos,
      changeAddress,
      actions,
      drepKeyHash: state.drepKeyHash,
    });
    log(`Lucid built canonical CBOR with ${actions.length} vote${actions.length === 1 ? "" : "s"}, ${plan.inputCount} fee input${plan.inputCount === 1 ? "" : "s"}, and ${plan.outputCount} fee-wallet change output${plan.outputCount === 1 ? "" : "s"}.`);
    const feeWitness = unwrapWalletHex(await state.feeApi.signTx(plan.unsignedTx, true), "Fee-wallet signTx result");
    verifyWitnessSet(feeWitness, plan.paymentHashes, plan.unsignedTx, "Fee wallet");
    state.plan = plan;
    state.unsignedTx = plan.unsignedTx;
    state.feeWitness = feeWitness;
    for (const control of elements.proposalRows.querySelectorAll("input, .vote-control button, .remove-proposal")) {
      control.disabled = true;
    }
    elements.summaryVotes.textContent = String(actions.length);
    elements.summaryInputs.textContent = String(plan.inputCount);
    elements.summaryFee.textContent = `${formatAda(plan.fee)} ADA`;
    elements.summaryChange.textContent = `${formatAda(plan.change)} ADA`;
    elements.summaryHash.textContent = plan.bodyHash;
    elements.txSummary.hidden = false;
    setState(elements.feeState, "Signed", "ok");
    log(`Fee witnesses verified. Canonical transaction body locked at ${plan.bodyHash}.`, "ok");
  }, elements.feeState));

  elements.signDrepSubmit.addEventListener("click", run(elements.signDrepSubmit, async () => {
    if (!state.drepApi || !state.unsignedTx || !state.feeWitness || !state.plan) {
      throw new Error("Build and fee-sign the transaction first.");
    }
    const currentHash = drepKeyHashFromPublicKey(await state.drepApi.cip95.getPubDRepKey());
    if (currentHash !== state.drepKeyHash) throw new Error("DRep wallet account changed. Reconnect and rebuild the transaction.");
    log("Requesting the DRep witness for the same canonical transaction body.");
    const drepWitness = unwrapWalletHex(await state.drepApi.signTx(state.unsignedTx, true), "DRep signTx result");
    verifyWitnessSet(drepWitness, [state.drepKeyHash], state.unsignedTx, "DRep wallet");
    const expectedHashes = [...state.plan.paymentHashes, state.drepKeyHash];
    const { finalTx, bodyHash } = await assembleCanonicalTransaction(
      state.plan,
      [state.feeWitness, drepWitness],
      expectedHashes,
      state.network,
    );
    if (typeof state.feeApi.submitTx !== "function") throw new Error("Fee wallet does not expose submitTx().");
    log("Lucid assembled the verified witnesses. Submitting canonical CBOR through the fee wallet.");
    const submittedHash = normalizeHex(await state.feeApi.submitTx(finalTx));
    if (submittedHash !== bodyHash) throw new Error(`Wallet returned unexpected transaction hash ${submittedHash}.`);
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
