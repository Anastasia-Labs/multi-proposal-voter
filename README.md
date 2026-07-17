# Multi-proposal Cardano DRep voter

A Mainnet web application for casting Yes, No, or Abstain votes on up to 20 Cardano governance actions in one transaction. It deliberately separates the two signing roles:

- The **fee wallet** supplies every transaction input, receives the single change output, provides the required payment witnesses, and submits the final transaction.
- The **DRep wallet** supplies only its CIP-95 DRep public key and DRep voting witness. The application never asks this wallet for UTxOs, payment addresses, or a change address.

The transaction is built, signed, assembled, and verified in the browser. The backend receives only public governance identifiers and returns public Mainnet data from [Koios](https://koios.rest/). Wallet UTxOs, addresses, transaction CBOR, and witnesses are never sent to the application server.

## Deploy to Vercel

1. In Vercel, choose **Add New Project** and import `Anastasia-Labs/multi-proposal-voter`.
2. Leave the framework preset as **Other** and the root directory as the repository root.
3. No build command, output directory, environment variable, database, or secret is required.
4. Deploy, then open the HTTPS deployment in a desktop browser profile containing the Cardano wallet extensions.

`vercel.json` configures the security headers and Node functions. Vercel serves `index.html`, `styles.css`, and `app.js` as static assets and deploys these narrow same-origin endpoints:

- `GET /api/network`
- `POST /api/validate-proposals`
- `POST /api/validate-drep`

The endpoints accept bounded, validated inputs and can query only the fixed Koios routes needed by this application. Each push to the connected production branch creates a new Vercel deployment.

## Requirements

- A desktop browser profile containing the Cardano wallet extensions, with site access enabled for the deployed domain or localhost.
- A Mainnet CIP-30 fee wallet with a suitable key-controlled UTxO. A clean ADA-only UTxO of at least 1.5 ADA is recommended.
- A separate Mainnet wallet or account that implements the [CIP-95 governance extension](https://cips.cardano.org/cips/cip95) and owns an active key-based DRep credential.
- Internet access for public Mainnet lookups and wallet submission.

## Vote

1. Paste an AdaStat governance URL, a governance action hex (`transaction hash + action index`), or `txHash#index`.
2. Choose **Yes**, **No**, or **Abstain**. Use **Add proposal** to include more votes in the same transaction.
3. Select **Validate proposals**. Every action must exist and still be open on Mainnet.
4. Select the fee provider and choose **Connect fee wallet**. This calls `window.cardano.<provider>.enable()`.
5. Select the DRep provider and choose **Connect DRep wallet**. This calls `enable({ extensions: [{ cip: 95 }] })`, derives the DRep ID from the public DRep key, and verifies its active registration.
6. Choose **Build and sign with fee wallet**. The application gets all inputs and the change address from this wallet and locks the transaction body after verifying the payment witnesses.
7. Choose **Sign with DRep and submit**. The application asks the DRep wallet to partially sign the identical body, rejects any witness other than the selected DRep credential, merges the witnesses, rechecks the final fee and size, and submits through the fee wallet.

Always review the network, votes, inputs, fee, and change shown by each wallet before approving.

## Transaction boundary

The Conway transaction body contains:

- Inputs selected exclusively from `feeApi.getUtxos()`.
- Exactly one output encoded from `feeApi.getChangeAddress()`.
- All input value minus the transaction fee in that fee-wallet change output.
- One voting-procedures map containing every selected governance action and the connected key-based DRep credential.
- No withdrawals, certificates, minting, collateral, or DRep-wallet inputs.

The DRep API is used only for `cip95.getPubDRepKey()` and partial `signTx()`. The fee API performs `getUtxos()`, `getChangeAddress()`, partial `signTx()`, and `submitTx()`.

## Run locally on Windows

No developer tools are required:

1. Extract the repository ZIP into a folder.
2. Double-click `start-server.cmd` and keep its terminal window open.
3. Open `http://127.0.0.1:8793/` in the browser profile containing the wallet extensions.
4. Press `Ctrl+C` in the terminal when finished.

The launcher uses Windows PowerShell 5.1 and binds only to `127.0.0.1`. Its execution-policy bypass applies only to that one PowerShell process.

## Run locally on macOS or Linux

```sh
python3 server.py --port 8793
```

Then open `http://127.0.0.1:8793/`. Do not open `index.html` through `file://`; wallet extensions normally do not inject `window.cardano` there, and the validation endpoints require an HTTP server.

For Vercel-compatible local development with Node.js 24 and the Vercel CLI:

```sh
npm test
vercel dev
```

## Safety and limitations

- Mainnet only.
- Fee inputs must be payment-key controlled. Script-controlled inputs are not supported.
- ADA-only UTxOs are preferred. A supported single token-bearing UTxO is preserved in change; the application will not burn native assets.
- A vote can fail if an action closes or a selected fee UTxO is spent before submission. Reset and rebuild in that case.
- Never enter a seed phrase, private key, signing key file, wallet password, or secret into this page.

Relevant standards: [CIP-30](https://cips.cardano.org/cip/CIP-30), [CIP-95](https://cips.cardano.org/cip/CIP-95), and [CIP-129](https://cips.cardano.org/cip/CIP-129).
