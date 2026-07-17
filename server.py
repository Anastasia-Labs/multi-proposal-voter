#!/usr/bin/env python3
"""Local static server and narrow Koios proxy for the multi-proposal voter."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


KOIOS_BASE = "https://api.koios.rest/api/v1"
TX_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
DREP_HASH_RE = re.compile(r"^[0-9a-f]{56}$")
DREP_ID_RE = re.compile(r"^drep1[023456789acdefghjklmnpqrstuvwxyz]{20,100}$")
MAX_ACTIONS = 20
ROOT = Path(__file__).resolve().parent


def koios_json(path: str, *, body: dict | None = None) -> object:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{KOIOS_BASE}/{path}",
        data=data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "cardano-local-multi-voter/1.0",
        },
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


class VoterHandler(SimpleHTTPRequestHandler):
    server_version = "CardanoLocalVoter/1.0"

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_json(self, status: HTTPStatus, payload: object) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        if urllib.parse.urlsplit(self.path).path == "/api/network":
            self.handle_network()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/validate-proposals":
            self.handle_validate_proposals()
            return
        if path == "/api/validate-drep":
            self.handle_validate_drep()
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown API endpoint."})

    def read_json_body(self) -> object:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length.") from error
        if length <= 0 or length > 32_768:
            raise ValueError("Request body must be between 1 and 32768 bytes.")
        return json.loads(self.rfile.read(length))

    def handle_network(self) -> None:
        try:
            params = koios_json("cli_protocol_params")
            tip_rows = koios_json("tip")
            tip = tip_rows[0]
            self.send_json(
                HTTPStatus.OK,
                {
                    "networkId": 1,
                    "epoch": tip["epoch_no"],
                    "absoluteSlot": tip["abs_slot"],
                    "blockTime": tip["block_time"],
                    "txFeePerByte": params["txFeePerByte"],
                    "txFeeFixed": params["txFeeFixed"],
                    "utxoCostPerByte": params["utxoCostPerByte"],
                    "maxTxSize": params["maxTxSize"],
                },
            )
        except (KeyError, IndexError, TypeError, urllib.error.URLError) as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"Koios network query failed: {error}"})

    def handle_validate_proposals(self) -> None:
        try:
            payload = self.read_json_body()
            actions = payload.get("actions") if isinstance(payload, dict) else None
            if not isinstance(actions, list) or not 1 <= len(actions) <= MAX_ACTIONS:
                raise ValueError(f"Provide between 1 and {MAX_ACTIONS} governance actions.")

            normalized: list[tuple[str, int]] = []
            seen: set[tuple[str, int]] = set()
            for action in actions:
                tx_hash = str(action.get("txHash", "")).lower() if isinstance(action, dict) else ""
                index = action.get("index") if isinstance(action, dict) else None
                if not TX_HASH_RE.fullmatch(tx_hash) or not isinstance(index, int) or not 0 <= index <= 65535:
                    raise ValueError("Each action needs a 64-character transaction hash and index from 0 to 65535.")
                key = (tx_hash, index)
                if key in seen:
                    raise ValueError(f"Duplicate governance action: {tx_hash}#{index}.")
                seen.add(key)
                normalized.append(key)

            tip_rows = koios_json("tip")
            current_epoch = int(tip_rows[0]["epoch_no"])
            results = []
            for tx_hash, index in normalized:
                query = urllib.parse.urlencode(
                    {
                        "proposal_tx_hash": f"eq.{tx_hash}",
                        "proposal_index": f"eq.{index}",
                        "select": (
                            "proposal_id,proposal_tx_hash,proposal_index,proposal_type,"
                            "proposed_epoch,expiration,ratified_epoch,enacted_epoch,"
                            "dropped_epoch,expired_epoch"
                        ),
                    }
                )
                rows = koios_json(f"proposal_list?{query}")
                if not rows:
                    results.append({"txHash": tx_hash, "index": index, "found": False, "open": False})
                    continue
                proposal = rows[0]
                terminal = any(
                    proposal.get(field) is not None
                    for field in ("ratified_epoch", "enacted_epoch", "dropped_epoch", "expired_epoch")
                )
                expiration = int(proposal["expiration"])
                results.append(
                    {
                        "txHash": tx_hash,
                        "index": index,
                        "found": True,
                        "open": not terminal and current_epoch <= expiration,
                        "proposalId": proposal["proposal_id"],
                        "proposalType": proposal["proposal_type"],
                        "proposedEpoch": proposal["proposed_epoch"],
                        "expirationEpoch": expiration,
                        "currentEpoch": current_epoch,
                        "ratifiedEpoch": proposal["ratified_epoch"],
                        "enactedEpoch": proposal["enacted_epoch"],
                        "droppedEpoch": proposal["dropped_epoch"],
                        "expiredEpoch": proposal["expired_epoch"],
                    }
                )

            self.send_json(HTTPStatus.OK, {"currentEpoch": current_epoch, "proposals": results})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except (KeyError, IndexError, TypeError, urllib.error.URLError) as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"Koios proposal query failed: {error}"})

    def handle_validate_drep(self) -> None:
        try:
            payload = self.read_json_body()
            drep_id = str(payload.get("drepId", "")).lower() if isinstance(payload, dict) else ""
            key_hash = str(payload.get("keyHash", "")).lower() if isinstance(payload, dict) else ""
            if not DREP_ID_RE.fullmatch(drep_id) or not DREP_HASH_RE.fullmatch(key_hash):
                raise ValueError("Provide a valid key-based CIP-129 DRep ID and key hash.")

            rows = koios_json("drep_info", body={"_drep_ids": [drep_id]})
            row = rows[0] if isinstance(rows, list) and rows else None
            if row is None:
                self.send_json(HTTPStatus.OK, {"found": False, "registered": False, "active": False})
                return
            if row.get("hex") != key_hash or row.get("drep_id") != drep_id or row.get("has_script") is not False:
                raise ValueError("Koios returned a DRep credential that does not match the connected key.")

            self.send_json(
                HTTPStatus.OK,
                {
                    "found": True,
                    "registered": row.get("drep_status") == "registered",
                    "active": row.get("active") is True,
                    "status": row.get("drep_status"),
                    "expiresEpoch": row.get("expires_epoch_no"),
                },
            )
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except (KeyError, IndexError, TypeError, urllib.error.URLError) as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"Koios DRep query failed: {error}"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the local Cardano multi-proposal voter.")
    parser.add_argument("--port", type=int, default=8793)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), VoterHandler)
    print(f"Multi-proposal voter: http://127.0.0.1:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
