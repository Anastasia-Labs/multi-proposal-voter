# Multi-proposal Cardano DRep voter

A Mainnet web application for casting Yes, No, or Abstain votes on up to 20 Cardano governance actions in one transaction. It deliberately separates the two wallet roles:

- The **fee wallet** supplies every input, receives every output and all change, provides the payment witnesses, and submits the final transaction.
- The **DRep wallet** supplies only its CIP-95 DRep public key and DRep voting witness. The application never requests its UTxOs, payment addresses, or change address.

Transaction construction uses [Lucid Evolution 0.6](https://anastasia-labs.github.io/lucid-evolution/) and its Cardano Multiplatform Library (CML), rather than a local CBOR encoder. Lucid loads Mainnet protocol parameters, selects fee-wallet inputs, calculates the fee and change, completes the transaction with `canonical: true`, and assembles both partial witness sets. The browser verifies the resulting CML transaction before signing and again before submission.

Wallet UTxOs, addresses, transaction CBOR, and witnesses remain in the browser. The backend receives only public governance identifiers and returns public Mainnet data from [Koios](https://koios.rest/).

## Deploy to Vercel

1. In Vercel, choose **Add New Project** and import `Anastasia-Labs/multi-proposal-voter`.
2. Use the **Vite** framework preset and leave the root directory as the repository root.
3. No environment variables, database, or secrets are required.
4. Deploy, then open the HTTPS deployment in a desktop browser profile containing the Cardano wallet extensions.

`vercel.json` runs `npm run build` and serves Vite's `dist` output. It also configures security headers and these narrow Node endpoints:

- `GET /api/network`
- `GET /api/koios/epoch_params` (fixed same-origin proxy used by Lucid)
- `POST /api/validate-proposals`
- `POST /api/validate-drep`

Each push to the connected production branch creates a new deployment.

## Requirements

- A desktop browser profile containing the Cardano wallet extensions, with site access enabled for the deployed domain or localhost.
- A Mainnet CIP-30 fee wallet with a suitable key-controlled UTxO. A clean ADA-only UTxO of at least 1.5 ADA is recommended.
- A separate Mainnet wallet or account implementing the [CIP-95 governance extension](https://cips.cardano.org/cips/cip95) and owning an active key-based DRep credential.
- Internet access for public Mainnet lookups and wallet submission.

## Vote

1. Paste an AdaStat governance URL, governance action hex (`transaction hash + action index`), or `txHash#index`.
2. Choose **Yes**, **No**, or **Abstain**. Use **Add proposal** to include more votes in the same transaction.
3. Select **Validate proposals**. Every action must exist and still be open on Mainnet.
4. Select the fee provider and choose **Connect fee wallet**. This calls `window.cardano.<provider>.enable()`.
5. Select the DRep provider and choose **Connect DRep wallet**. This requests CIP-95, derives the DRep ID from the public DRep key, and verifies its active registration.
6. Choose **Build and sign with fee wallet**. Lucid gets all inputs and the exact change address from this wallet, completes canonical CBOR, and the application verifies the payment witnesses.
7. Choose **Sign with DRep and submit**. The DRep wallet partially signs the identical canonical transaction, the application rejects witnesses from any other DRep credential, Lucid assembles both witness sets, and the fee wallet submits it.

Always review the network, votes, inputs, fee, and change shown by each wallet before approving.

## Transaction boundary

The completed Conway transaction is checked to contain:

- Inputs selected exclusively from payment-key-controlled UTxOs returned by the fee wallet through Lucid's CIP-30 adapter.
- Every output addressed to the fee wallet's exact CIP-30 change address.
- One DRep voter with every selected governance action and vote choice.
- No withdrawals, certificates, minting, collateral, reference inputs, proposal procedures, required signers, or treasury operations.
- Canonical transaction and body CBOR before either wallet signs and after Lucid assembles the witnesses.

The DRep API is used only for `cip95.getPubDRepKey()` and partial `signTx()`. It is never used for inputs, outputs, change, or submission.

## Run locally on Windows

No developer tools are required when using the complete repository or release ZIP, because the compiled Lucid JavaScript and WASM files are included in `dist`:

1. Extract the ZIP into a folder.
2. Double-click `start-server.cmd` and keep its terminal window open.
3. Open `http://127.0.0.1:8793/` in the browser profile containing the wallet extensions.
4. Press `Ctrl+C` in the terminal when finished.

The launcher uses Windows PowerShell 5.1 and binds only to `127.0.0.1`. Its execution-policy bypass applies only to that PowerShell process.

## Develop and build

Node.js 24 is required to rebuild the bundled assets:

```sh
npm ci
npm run check
npm run dev
```

For a production-style local run on macOS or Linux:

```sh
npm run build
python3 server.py --port 8793
```

Do not open `index.html` through `file://`; wallet extensions normally do not inject `window.cardano` there, and the validation endpoints require an HTTP server.

## Hardware wallets

[CIP-21](https://cips.cardano.org/cip/CIP-0021) requires canonical CBOR for hardware-wallet interoperability, so the application uses Lucid's canonical completion and serialization options throughout. Canonical encoding is necessary but does not add governance support to a device or wallet extension that lacks it. Check that the chosen extension, device firmware, and Cardano app support Conway voting procedures before approving a transaction.

## Safety and limitations

- Mainnet only.
- Fee inputs must be payment-key controlled; script-controlled inputs are excluded.
- Native assets in selected fee UTxOs are preserved in fee-wallet change and are never sent to the DRep wallet.
- A vote can fail if an action closes or a selected fee UTxO is spent before submission. Reset and rebuild in that case.
- Never enter a seed phrase, private key, signing key file, wallet password, or secret into this page.

Relevant standards: [CIP-30](https://cips.cardano.org/cip/CIP-30), [CIP-95](https://cips.cardano.org/cips/cip95), [CIP-129](https://cips.cardano.org/cip/CIP-129), and [CIP-21](https://cips.cardano.org/cip/CIP-0021).
