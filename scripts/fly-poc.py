#!/usr/bin/env python3
"""Run the m2m channel PoC on two temporary Fly Machines.

The runner deliberately uses pre-registered local identities.  It transfers
only each role's identity and endpoint key, plus the provider gas signer and
the buyer controller signer, into the corresponding Machine.  It never needs a
provider controller or deployer key on the provider Machine.

The command creates one app, two one-gigabyte volumes, and two Machines unless
--reuse-app is supplied.  It tears down only the Machines and volumes it
created, and only after a terminal Sui state has been confirmed.  An unknown
terminal outcome is preserved for manual recovery.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import ipaddress
from io import BytesIO
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from typing import Any, Iterable


class FlyError(RuntimeError):
    """A Fly control-plane command failed."""


def _json_documents(text: str) -> list[Any]:
    """Extract JSON values from flyctl output with optional human text around it."""
    decoder = json.JSONDecoder()
    values: list[Any] = []
    for offset, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, end = decoder.raw_decode(text[offset:])
        except json.JSONDecodeError:
            continue
        if end > 0:
            values.append(value)
    return values


def _json_value(text: str) -> Any:
    # Prefer a complete top-level value.  A ticket/status object contains
    # nested objects, and returning the last nested object would be incorrect.
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    best: tuple[int, Any] | None = None
    for offset, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, end = decoder.raw_decode(text[offset:])
        except json.JSONDecodeError:
            continue
        if best is None or end > best[0]:
            best = (end, value)
    if best is None:
        raise FlyError("flyctl returned no JSON value")
    return best[1]


def _records(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _records(child)
    elif isinstance(value, list):
        for child in value:
            yield from _records(child)


def _field(record: dict[str, Any], *names: str) -> Any:
    wanted = {name.lower() for name in names}
    for key, value in record.items():
        if key.lower() in wanted:
            return value
    return None


def _write_private_bytes(path: Path, contents: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_bytes(contents)
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def _write_private(path: Path, contents: str) -> None:
    _write_private_bytes(path, contents.encode())


def _safe_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError(f"invalid Fly/app/session name: {value!r}")
    return value


def _volume_name(run_id: str, role: str) -> str:
    # Fly volumes allow only lowercase alphanumeric/underscore, maximum 30.
    suffix = sha256(f"{run_id}:{role}".encode()).hexdigest()[:16]
    return f"m2m_{suffix}_{role}"


def _ip_host(value: str) -> str | None:
    if value.startswith("[") and "]" in value:
        return value[1:value.index("]")]
    if value.count(":") == 1:
        return value.rsplit(":", 1)[0]
    # An unbracketed IPv6 address without a port is also accepted by iroh.
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return None
    return value


def _public_ip_route(value: str) -> bool:
    host = _ip_host(value)
    if host is None:
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def _filter_ticket(ticket: dict[str, Any], path: str) -> tuple[dict[str, Any], list[dict[str, str]], list[dict[str, str]]]:
    if ticket.get("version") != 1 or ticket.get("method") != "sui.channel.v1":
        raise ValueError("provider ticket is not sui.channel.v1 version 1")
    endpoint = ticket.get("endpoint")
    if not isinstance(endpoint, dict) or not isinstance(endpoint.get("addrs"), list):
        raise ValueError("provider ticket has no endpoint address list")

    allowed: list[dict[str, Any]] = []
    routes: list[dict[str, str]] = []
    dropped: list[dict[str, str]] = []
    for route in endpoint["addrs"]:
        if not isinstance(route, dict) or len(route) != 1:
            raise ValueError("provider ticket contains a malformed transport route")
        kind, value = next(iter(route.items()))
        if kind == "Relay" and path == "relay":
            allowed.append(route)
            routes.append({"kind": "relay", "value": str(value)})
        elif kind == "Ip" and path == "direct" and isinstance(value, str) and _public_ip_route(value):
            allowed.append(route)
            routes.append({"kind": "public-ip", "value": value})
        else:
            reason = "relay-route-excluded-from-direct-test" if kind == "Relay" else "non-global-ip-excluded"
            dropped.append({"kind": kind, "reason": reason})

    if path == "relay" and not any(route["kind"] == "relay" for route in routes):
        raise ValueError("relay-only ticket has no Relay route")
    if path == "direct" and not any(route["kind"] == "public-ip" for route in routes):
        raise ValueError(
            "provider exposed no globally routable IP route; refusing a direct test "
            "that could fall back to Fly 6PN/private addressing"
        )
    filtered = dict(ticket)
    filtered["endpoint"] = dict(endpoint)
    filtered["endpoint"]["addrs"] = allowed
    return filtered, routes, dropped


@dataclass
class Resource:
    kind: str
    identifier: str
    name: str
    region: str


class Fly:
    def __init__(self, app: str, repo: Path) -> None:
        candidates = []
        configured = shutil.which("flyctl")
        if configured:
            candidates.append(Path(configured))
        candidates.append(Path.home() / ".fly" / "bin" / "flyctl")
        self.binary = next((path for path in candidates if path.is_file()), None)
        if self.binary is None:
            raise FlyError("flyctl not found; install it or place it at ~/.fly/bin/flyctl")
        self.app = app
        self.repo = repo

    def run(self, arguments: list[str], *, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess[str]:
        command = [str(self.binary), *arguments]
        try:
            result = subprocess.run(
                command,
                cwd=self.repo,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise FlyError(f"flyctl timed out: {' '.join(arguments[:3])}") from error
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            if len(detail) > 4000:
                detail = detail[-4000:]
            raise FlyError(f"flyctl failed ({result.returncode}): {detail}")
        return result

    def list_apps(self, org: str) -> list[dict[str, Any]]:
        result = self.run(["apps", "list", "--json", "--org", org])
        return [record for record in _records(_json_value(result.stdout))
                if _field(record, "name") is not None]

    def app_exists(self, org: str) -> bool:
        return any(_field(record, "name") == self.app for record in self.list_apps(org))

    def create_app(self, org: str) -> None:
        self.run(["apps", "create", self.app, "--org", org, "--yes"], timeout=120)

    def list_volumes(self) -> list[dict[str, Any]]:
        result = self.run(["volumes", "list", "--json", "--app", self.app])
        return [record for record in _records(_json_value(result.stdout))
                if _field(record, "id", "volume_id") is not None]

    def create_volume(self, name: str, region: str, size: int) -> Resource:
        if any(_field(v, "name") == name for v in self.list_volumes()):
            raise FlyError("volume name already exists; use a fresh run ID")
        self.run([
            "volumes", "create", name, "--app", self.app, "--region", region,
            "--size", str(size), "--yes", "--json", "--scheduled-snapshots=false",
        ], timeout=180)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            for record in self.list_volumes():
                if _field(record, "name") == name and _field(record, "region") == region:
                    identifier = _field(record, "id", "volume_id")
                    return Resource("volume", str(identifier), name, region)
            time.sleep(1)
        raise FlyError(f"created volume {name!r} but could not resolve its ID")

    def list_machines(self) -> list[dict[str, Any]]:
        result = self.run(["machine", "list", "--json", "--app", self.app])
        return [record for record in _records(_json_value(result.stdout))
                if _field(record, "id", "machine_id") is not None]

    def create_machine(
        self,
        name: str,
        region: str,
        volume: Resource,
        files: list[tuple[str, Path]],
        image: str,
        org: str,
    ) -> Resource:
        if any(_field(v, "name") == name for v in self.list_machines()):
            raise FlyError("Machine name already exists; use a fresh run ID")
        command = [
            "machine", "run", image,
            "--app", self.app,
            "--org", org,
            "--region", region,
            "--name", name,
            "--autostop=off",
            "--restart", "no",
            "--skip-dns-registration",
            "--vm-size", "shared-cpu-1x",
            "--vm-memory", "512",
            "--volume", f"{volume.identifier}:/state",
        ]
        if image == ".":
            command.extend(["--dockerfile", "Dockerfile"])
        for guest, local in files:
            command.extend(["--file-local", f"{guest}={local}"])
        command.extend(["sleep", "infinity"])
        self.run(command, timeout=900)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            for record in self.list_machines():
                if _field(record, "name") == name:
                    identifier = _field(record, "id", "machine_id")
                    actual_region = _field(record, "region")
                    if actual_region != region:
                        raise FlyError("created Machine region differs from request or is missing")
                    return Resource("machine", str(identifier), name, actual_region)
            time.sleep(1)
        raise FlyError(f"created Machine {name!r} but could not resolve its ID")

    def shell(self, machine: Resource, script: str, *, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess[str]:
        # flyctl v0.4.101 accepts one shell command argument and its process
        # exit code does not reflect the remote command. Read structured output.
        raw = self.run([
            "machine", "exec", "--app", self.app, "--timeout", str(min(600, max(1, int(timeout)))),
            "--json", machine.identifier, shlex.join(["sh", "-lc", script]),
        ], check=check, timeout=timeout + 20)
        if raw.returncode != 0:
            return raw
        value = _json_value(raw.stdout)
        code = _field(value, "exit_code", "exitcode") or 0
        stdout = _field(value, "stdout", "std_out") or ""
        stderr = _field(value, "stderr", "std_err") or ""
        if not isinstance(code, int) or not isinstance(stdout, str) or not isinstance(stderr, str):
            raise FlyError("machine exec omitted structured remote exit status")
        result = subprocess.CompletedProcess(raw.args, code, stdout, stderr)
        if check and code:
            raise FlyError(f"remote command failed ({code}): {(stderr or stdout)[-4000:]}")
        return result

    def exec(self, machine: Resource, command: list[str], *, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess[str]:
        return self.shell(machine, shlex.join(command), check=check, timeout=timeout)

    def machine_status(self, machine: Resource) -> dict[str, Any]:
        result = self.run(["machine", "status", machine.identifier, "--app", self.app, "--display-config"], check=False)
        values = _json_documents(result.stdout)
        return values[-1] if values and isinstance(values[-1], dict) else {}

    def stop_destroy(self, machine: Resource) -> list[str]:
        errors: list[str] = []
        stopped = self.run([
            "machine", "stop", machine.identifier, "--app", self.app,
            "--signal", "SIGINT", "--timeout", "20", "--wait-timeout", "45s",
        ], check=False, timeout=90)
        if stopped.returncode != 0 and "already stopped" not in (stopped.stderr or "").lower():
            errors.append(f"stop {machine.identifier}: {(stopped.stderr or stopped.stdout).strip()[-1000:]}")
        destroyed = self.run([
            "machine", "destroy", machine.identifier, "--app", self.app, "--force",
        ], check=False, timeout=90)
        if destroyed.returncode != 0 and "not found" not in (destroyed.stderr or "").lower():
            errors.append(f"destroy {machine.identifier}: {(destroyed.stderr or destroyed.stdout).strip()[-1000:]}")
        return errors

    def destroy_volume(self, volume: Resource) -> str | None:
        result = self.run([
            "volumes", "destroy", volume.identifier, "--app", self.app, "--yes",
        ], check=False, timeout=90)
        if result.returncode != 0 and "not found" not in (result.stderr or "").lower():
            return f"destroy volume {volume.identifier}: {(result.stderr or result.stdout).strip()[-1000:]}"
        return None


def _validate_inputs(args: argparse.Namespace) -> dict[str, Any]:
    config_path = Path(args.chain_config).resolve()
    config = json.loads(config_path.read_text())
    if config.get("network") != "testnet":
        raise ValueError("Fly cross-network PoC requires a public Sui testnet chain.json")
    for key in ("rpc_url", "chain_id", "package_id", "deployment"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise ValueError(f"chain config is missing {key}")

    def file_path(value: str, label: str) -> Path:
        path = Path(value).resolve()
        if not path.is_file():
            raise ValueError(f"{label} is not a file: {path}")
        return path

    def state_path(value: str, label: str) -> Path:
        path = Path(value).resolve()
        for child in ("identity.json", "endpoint-key.json"):
            if not (path / child).is_file():
                raise ValueError(f"{label} is missing {child}: {path}")
        identity = json.loads((path / "identity.json").read_text())
        identity_chain = identity.get("chain")
        if identity_chain != config:
            raise ValueError(f"{label}/identity.json does not match --chain-config")
        if not isinstance(identity.get("agent"), str):
            raise ValueError(f"{label}/identity.json has no agent address")
        return path

    provider_state = state_path(args.provider_state, "provider state")
    buyer_state = state_path(args.buyer_state, "buyer state")
    provider_gas = file_path(args.provider_gas, "provider gas signer")
    buyer_signer = file_path(args.buyer_signer, "buyer controller signer")
    if not 1 <= args.command_timeout <= 600:
        raise ValueError("--command-timeout must be between 1 and 600 seconds")
    if not 1 <= args.jobs <= 100:
        raise ValueError("--jobs must be between 1 and 100 for this bounded PoC")
    if args.unit_price <= 0 or args.deposit < args.jobs * args.unit_price:
        raise ValueError("--deposit must cover jobs * unit price")
    if args.work_ms < 10_000 or args.grace_ms < 10_000 or args.work_ms + args.grace_ms > 3_600_000:
        raise ValueError("work/grace horizons do not fit the channel limits")
    return {
        "config": config,
        "config_path": config_path,
        "provider_state": provider_state,
        "buyer_state": buyer_state,
        "provider_gas": provider_gas,
        "buyer_signer": buyer_signer,
    }


def _identity_agent(state: Path) -> str:
    identity = json.loads((state / "identity.json").read_text())
    return str(identity["agent"])


def _remote_json(fly: Fly, machine: Resource, path: str) -> dict[str, Any]:
    result = fly.exec(machine, ["cat", path], timeout=30)
    value = _json_value(result.stdout)
    if not isinstance(value, dict):
        raise FlyError(f"remote file is not a JSON object: {path}")
    return value


def _wait_ticket(fly: Fly, machine: Resource, path: str, timeout_seconds: float = 90) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error = "ticket not written yet"
    while time.monotonic() < deadline:
        result = fly.exec(machine, ["cat", path], check=False, timeout=20)
        if result.returncode == 0:
            try:
                value = _json_value(result.stdout)
                if isinstance(value, dict):
                    return value
            except FlyError as error:
                last_error = str(error)
        else:
            last_error = (result.stderr or result.stdout).strip()[-1000:]
        time.sleep(1)
    raise FlyError(f"provider ticket readiness timed out: {last_error}")


def _remote_tx_records(fly: Fly, machine: Resource) -> list[dict[str, Any]]:
    script = (
        "const fs=require('node:fs');const path=require('node:path');"
        "const d=process.argv[1];let out=[];"
        "if(fs.existsSync(d))for(const n of fs.readdirSync(d))if(n.endsWith('.tx.json')){"
        "const j=JSON.parse(fs.readFileSync(path.join(d,n),'utf8'));"
        "out.push({file:n,state:j.state??null,digest:j.digest??null,gas:j.gas??null});}"
        "process.stdout.write(JSON.stringify(out));"
    )
    result = fly.exec(machine, ["node", "-e", script, "/state/channels/tx"], timeout=30)
    value = _json_value(result.stdout)
    if not isinstance(value, list):
        raise FlyError("remote transaction journal listing is not an array")
    return [record for record in value if isinstance(record, dict)]


def _remote_session_economics(fly: Fly, machine: Resource, session: str) -> dict[str, Any]:
    script = (
        "const fs=require('node:fs');const p=process.argv[1];"
        "const j=JSON.parse(fs.readFileSync(p,'utf8'));"
        "const s=j.chain_state??{};const o=s.offer??j.offer?.payload??{};"
        "process.stdout.write(JSON.stringify({requested_deposit:j.requested_deposit??null,"
        "offer_deposit:o.deposit??null,chain_state:{status:s.status??null,funds:s.funds??null,"
        "redeemed_amount:s.redeemed_amount??null,redeemed_sequence:s.redeemed_sequence??null}}));"
    )
    path = f"/state/channels/sessions/{session}.json"
    result = fly.exec(machine, ["node", "-e", script, path], timeout=30)
    value = _json_value(result.stdout)
    if not isinstance(value, dict):
        raise FlyError("remote session economics is not an object")
    return value


def _u64(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} is a boolean, not u64")
    if isinstance(value, int) and 0 <= value <= 18_446_744_073_709_551_615:
        return value
    if isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
        parsed = int(value)
        if parsed <= 18_446_744_073_709_551_615:
            return parsed
    raise ValueError(f"{label} is not a canonical u64")


def _hard_success_checks(
    status: dict[str, Any], economics: dict[str, Any], transactions: list[dict[str, Any]],
    jobs: int, unit_price: int, session: str, expected_deposit: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    expected_paid = jobs * unit_price
    state = economics.get("chain_state")
    if not isinstance(state, dict):
        raise ValueError("session journal has no onchain chain_state")
    completed = _u64(status.get("completed_jobs"), "completed_jobs")
    authorized = _u64(status.get("authorized"), "authorized")
    redeemed = _u64(status.get("redeemed"), "redeemed")
    residual = _u64(status.get("residual"), "residual")
    state_status = _u64(state.get("status"), "chain_state.status")
    state_funds = _u64(state.get("funds"), "chain_state.funds")
    state_paid = _u64(state.get("redeemed_amount"), "chain_state.redeemed_amount")
    deposit = _u64(economics.get("offer_deposit"), "offer.deposit")
    refund_derived = deposit - state_paid if state_paid <= deposit else -1

    confirmed = [
        record for record in transactions
        if record.get("state") == "confirmed" and isinstance(record.get("digest"), str) and record["digest"]
    ]
    expected_files = {f"{session}.open.tx.json", f"{session}.close.tx.json"}
    confirmed_files = {Path(str(record.get("file", ""))).name for record in confirmed}
    confirmed_digests = {record["digest"] for record in confirmed}
    checks: dict[str, Any] = {
        "two_distinct_confirmed_economic_transactions": (
            len(confirmed) == 2 and len(confirmed_digests) == 2 and confirmed_files == expected_files
        ),
        "open_transaction_confirmed": any(Path(str(r.get("file", ""))).name == f"{session}.open.tx.json" for r in confirmed),
        "close_transaction_confirmed": any(Path(str(r.get("file", ""))).name == f"{session}.close.tx.json" for r in confirmed),
        "closed_status": status.get("phase") == "closed" and status.get("terminal") is True and state_status == 1,
        "completed_jobs": completed == jobs,
        "authorized_amount": authorized == expected_paid,
        "deposit_amount": deposit == expected_deposit and _u64(economics.get("requested_deposit"), "requested_deposit") == expected_deposit,
        "redeemed_amount": redeemed == expected_paid and state_paid == expected_paid,
        "residual_zero": residual == 0 and state_funds == 0,
        "refund_derived_from_deposit_minus_paid": refund_derived == expected_deposit - expected_paid,
    }
    details = {
        "deposit": deposit,
        "paid": state_paid,
        "refund_derived": refund_derived,
        "expected_paid": expected_paid,
        "chain_state": {
            "status": state_status,
            "funds": state_funds,
            "redeemed_amount": state_paid,
            "redeemed_sequence": state.get("redeemed_sequence"),
        },
        "confirmed_transactions": confirmed,
    }
    return checks, details


def _archive_state(fly: Fly, machine: Resource, path: Path) -> dict[str, Any]:
    """Download the complete role volume before it can be destroyed."""
    script = "set -eu; tar -C /state -czf /run/m2m/state-archive.tar.gz .; base64 --wrap=0 /run/m2m/state-archive.tar.gz; rm /run/m2m/state-archive.tar.gz"
    result = fly.shell(machine, script, timeout=180)
    encoded = "".join(result.stdout.split())
    try:
        archive = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise FlyError("remote /state archive was not valid base64") from error
    if not archive:
        raise FlyError("remote /state archive was empty")
    try:
        with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as tar:
            members = tar.getmembers()
            names = [member.name for member in members]
            if any(name.startswith("/") or ".." in Path(name).parts for name in names):
                raise FlyError("remote /state archive contains an unsafe path")
    except (tarfile.TarError, EOFError) as error:
        raise FlyError("remote /state archive was not a valid gzip tar") from error
    _write_private_bytes(path, archive)
    return {
        "path": str(path),
        "bytes": len(archive),
        "sha256": sha256(archive).hexdigest(),
        "entries": len(names),
        "complete_state_volume": True,
    }


def _save_text(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o600)


def _transport_events(source: str, text: str) -> list[dict[str, Any]]:
    """Keep the runtime's selected public Iroh path observations in evidence."""
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("event") in {"channel_connected", "channel_jobs_end"}:
            events.append({"source": source, **value})
    return events


def _verified_paths(events: list[dict[str, Any]], mode: str) -> bool:
    # Iroh 1.2.0 PathList snapshots identify the selected path by PathId.
    # Require observations at both connection establishment and jobs completion.
    for kind in ("channel_connected", "channel_jobs_end"):
        candidates = [e for e in events if e.get("source") == "buyer" and e.get("event") == kind]
        if len(candidates) != 1:
            return False
        paths = candidates[0].get("paths", "")
        selected = re.search(r"selected: Some\(PathId\((\d+)\)\)", paths)
        if not selected:
            return False
        route = re.search(r"PathData\(" + selected.group(1) + r", ([^)]*)\)", paths)
        if not route:
            return False
        value = route.group(1)
        if mode == "relay":
            if not value.startswith("relay:https://"):
                return False
        else:
            if not value.startswith("ip:"):
                return False
            address = value[3:]
            host = address[1:address.index("]")] if address.startswith("[") else address.rsplit(":", 1)[0]
            try:
                if not ipaddress.ip_address(host).is_global:
                    return False
            except ValueError:
                return False
    return True


def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    repo = Path(__file__).resolve().parents[1]
    inputs = _validate_inputs(args)
    run_id = args.run_id or datetime.now(timezone.utc).strftime("%y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
    _safe_name(run_id)
    session = args.session or f"fly-{run_id}"
    _safe_name(session)
    report_dir = (Path(args.report_dir) / run_id).resolve()
    report_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    report_path = report_dir / "report.json"

    report: dict[str, Any] = {
        "version": 1,
        "run_id": run_id,
        "session": session,
        "app": args.app,
        "org": args.org,
        "path_requested": args.path,
        "image": args.image,
        "resource_intents": [],
        "network": "testnet",
        "regions_requested": {"provider": args.provider_region, "buyer": args.buyer_region},
        "machines": {},
        "volumes": {},
        "timing_ms": {},
        "cleanup": {"requested": not args.keep, "performed": False, "errors": []},
    }
    started = time.monotonic()
    fly = Fly(args.app, repo)
    created_app = False
    machines: list[Resource] = []
    volumes: list[Resource] = []
    buyer: Resource | None = None
    provider: Resource | None = None
    terminal_confirmed = False
    failure: Exception | None = None

    def checkpoint() -> None:
        report["tracked_resources"] = [
            {"kind": r.kind, "id": r.identifier, "name": r.name, "region": r.region}
            for r in [*machines, *volumes]
        ]
        _write_private(report_path, json.dumps(report, indent=2) + "\n")

    def intended(kind: str, name: str, region: str) -> None:
        # Persist names before the control-plane mutation. If the API response
        # is lost, these exact names can resolve an uncertain created resource.
        report["resource_intents"].append({"kind": kind, "name": name, "region": region})
        checkpoint()

    def timing(name: str) -> None:
        report["timing_ms"][name] = round((time.monotonic() - started) * 1000)
        checkpoint()

    try:
        if fly.app_exists(args.org):
            if not args.reuse_app:
                raise FlyError(
                    f"app {args.app!r} already exists in {args.org!r}; refusing to touch it "
                    "(use a new name or explicitly pass --reuse-app)"
                )
            report["app_reused"] = True
        else:
            fly.create_app(args.org)
            created_app = True
            report["app_created"] = True
        timing("app_ready")

        intended("volume", _volume_name(run_id, "provider"), args.provider_region)
        provider_volume = fly.create_volume(_volume_name(run_id, "provider"), args.provider_region, args.volume_size)
        volumes.append(provider_volume)
        intended("volume", _volume_name(run_id, "buyer"), args.buyer_region)
        buyer_volume = fly.create_volume(_volume_name(run_id, "buyer"), args.buyer_region, args.volume_size)
        volumes.append(buyer_volume)
        report["volumes"] = {
            "provider": {"id": provider_volume.identifier, "name": provider_volume.name, "region": provider_volume.region},
            "buyer": {"id": buyer_volume.identifier, "name": buyer_volume.name, "region": buyer_volume.region},
        }
        timing("volumes_ready")

        provider_name = f"{run_id}-provider"
        buyer_name = f"{run_id}-buyer"
        provider_files = [
            ("/run/m2m/identity.json", inputs["provider_state"] / "identity.json"),
            ("/run/m2m/endpoint-key.json", inputs["provider_state"] / "endpoint-key.json"),
            ("/run/m2m/provider-gas.json", inputs["provider_gas"]),
        ]
        intended("machine", provider_name, args.provider_region)
        provider = fly.create_machine(provider_name, args.provider_region, provider_volume, provider_files, args.image, args.org)
        machines.append(provider)
        report["machines"]["provider"] = {"id": provider.identifier, "name": provider.name, "region": provider.region}
        fly.shell(provider, "install -m 600 /run/m2m/identity.json /state/identity.json && install -m 600 /run/m2m/endpoint-key.json /state/endpoint-key.json")
        remote_identity = _remote_json(fly, provider, "/state/identity.json")
        if remote_identity.get("agent") != _identity_agent(inputs["provider_state"]):
            raise FlyError("provider Machine identity differs from the pre-registered identity")
        timing("provider_ready")

        relay_flag = ["--relay-only"] if args.path == "relay" else []
        provider_command = [
            "/usr/local/bin/m2m", "--state", "/state", "channel-serve",
            "--file", "/app/fixtures/hello.txt",
            "--gas-signer", "/run/m2m/provider-gas.json",
            "--ticket", "/state/channel-ticket.json",
            "--unit-price", str(args.unit_price),
            "--max-jobs", str(max(args.jobs, 10)),
            "--work-ms", str(args.work_ms),
            "--grace-ms", str(args.grace_ms),
            *relay_flag,
        ]
        provider_shell = f"nohup {shlex.join(provider_command)} </dev/null >/state/provider.log 2>&1 & echo $!"
        fly.shell(provider, provider_shell, timeout=30)
        raw_ticket = _wait_ticket(fly, provider, "/state/channel-ticket.json")
        filtered_ticket, routes, dropped = _filter_ticket(raw_ticket, args.path)
        local_ticket = report_dir / "provider-ticket.json"
        _write_private(local_ticket, json.dumps(filtered_ticket, indent=2) + "\n")
        report["connection"] = {
            "path": "relay" if args.path == "relay" else "direct",
            "selection": "relay-only Iroh transport" if args.path == "relay" else "direct-only Iroh transport with global IP ticket routes",
            "routes": routes,
            "excluded_routes": dropped,
            "private_6pn_policy": "non-global IP routes are excluded before the buyer receives the ticket",
        }
        timing("ticket_ready")

        buyer_files = [
            ("/run/m2m/identity.json", inputs["buyer_state"] / "identity.json"),
            ("/run/m2m/endpoint-key.json", inputs["buyer_state"] / "endpoint-key.json"),
            ("/run/m2m/buyer-controller.json", inputs["buyer_signer"]),
            ("/run/m2m/channel-ticket.json", local_ticket),
        ]
        intended("machine", buyer_name, args.buyer_region)
        buyer = fly.create_machine(buyer_name, args.buyer_region, buyer_volume, buyer_files, args.image, args.org)
        machines.append(buyer)
        report["machines"]["buyer"] = {"id": buyer.identifier, "name": buyer.name, "region": buyer.region}
        fly.shell(buyer, "install -m 600 /run/m2m/identity.json /state/identity.json && install -m 600 /run/m2m/endpoint-key.json /state/endpoint-key.json")
        remote_identity = _remote_json(fly, buyer, "/state/identity.json")
        if remote_identity.get("agent") != _identity_agent(inputs["buyer_state"]):
            raise FlyError("buyer Machine identity differs from the pre-registered identity")
        timing("buyer_ready")

        buyer_command = [
            "/usr/local/bin/m2m", "--state", "/state", "channel-buy",
            "--provider", _identity_agent(inputs["provider_state"]),
            "--ticket", "/run/m2m/channel-ticket.json",
            "--expected-file", "/app/fixtures/hello.txt",
            "--signer", "/run/m2m/buyer-controller.json",
            "--session", session,
            "--jobs", str(args.jobs),
            "--deposit", str(args.deposit),
            "--max-unit-price", str(args.unit_price),
            *relay_flag,
        ]
        buyer_result = fly.exec(buyer, buyer_command, check=False, timeout=args.command_timeout)
        _save_text(report_dir / "buyer.stdout.log", buyer_result.stdout)
        _save_text(report_dir / "buyer.stderr.log", buyer_result.stderr)
        if buyer_result.returncode != 0:
            raise FlyError(f"channel-buy failed: {(buyer_result.stderr or buyer_result.stdout).strip()[-4000:]}")
        buyer_outcome = _json_value(buyer_result.stdout)
        report["buyer_outcome"] = buyer_outcome
        timing("buyer_complete")

        status_result = fly.exec(buyer, [
            "/usr/local/bin/m2m", "--state", "/state", "channel-status", "--session", session,
        ], timeout=args.command_timeout)
        status = _json_value(status_result.stdout)
        report["status"] = status
        economics = _remote_session_economics(fly, buyer, session)
        tx_records = _remote_tx_records(fly, buyer)
        report["transactions"] = tx_records
        checks, accounting = _hard_success_checks(
            status, economics, tx_records, args.jobs, args.unit_price, session, args.deposit,
        )
        report["hard_success"] = {"passed": all(checks.values()), "checks": checks}
        report["channel"] = {
            "id": status.get("channel") if isinstance(status, dict) else None,
            "phase": status.get("phase") if isinstance(status, dict) else None,
            "terminal": checks["closed_status"],
            "completed_jobs": status.get("completed_jobs") if isinstance(status, dict) else None,
            "authorized": status.get("authorized") if isinstance(status, dict) else None,
            "redeemed": status.get("redeemed") if isinstance(status, dict) else None,
            "residual": status.get("residual") if isinstance(status, dict) else None,
            "close_digest": status.get("digest") if isinstance(status, dict) else None,
            "economic_transaction_count": len([
                record for record in tx_records
                if record.get("state") == "confirmed" and record.get("digest")
            ]),
            "accounting": accounting,
        }
        provider_log = fly.exec(provider, ["cat", "/state/provider.log"], check=False, timeout=30)
        _save_text(report_dir / "provider.log", provider_log.stdout)
        report["connection"]["runtime_events"] = (
            _transport_events("buyer", buyer_result.stderr)
            + _transport_events("provider", provider_log.stdout)
        )
        observed = report["connection"]["runtime_events"]
        checks["different_actual_regions"] = provider.region != buyer.region
        checks["requested_regions"] = provider.region == args.provider_region and buyer.region == args.buyer_region
        checks["selected_transport_path"] = _verified_paths(observed, args.path)
        report["hard_success"]["passed"] = all(checks.values())
        if not all(checks.values()):
            raise FlyError("local outcome, region, or selected path check failed")
        expected_path = report_dir / "expected-chain-audit.json"
        by_name = {record["file"]: record for record in tx_records}
        expected = {
            "channel": status["channel"],
            "buyer": _identity_agent(inputs["buyer_state"]),
            "provider": _identity_agent(inputs["provider_state"]),
            "deposit": str(args.deposit), "paid": str(args.jobs * args.unit_price),
            "open_digest": by_name[f"{session}.open.tx.json"]["digest"],
            "close_digest": by_name[f"{session}.close.tx.json"]["digest"],
        }
        _write_private(expected_path, json.dumps(expected, indent=2) + "\n")
        audit_path = report_dir / "chain-audit.json"
        checked = subprocess.run([
            "node", "--import", "tsx", "scripts/verify-channel-run.ts",
            str(inputs["config_path"]), str(expected_path), str(audit_path),
        ], cwd=repo, capture_output=True, text=True, timeout=120)
        _save_text(report_dir / "chain-audit.stderr.log", checked.stderr)
        if checked.returncode:
            raise FlyError(f"independent Sui audit failed: {checked.stderr[-4000:]}")
        report["chain_audit"] = json.loads(audit_path.read_text())
        checks["independent_sui_audit"] = True
        timing("terminal_reconciled")
        terminal_confirmed = bool(report["hard_success"]["passed"])
        if not terminal_confirmed:
            failed = [name for name, passed in checks.items() if not passed]
            raise FlyError("channel hard-success checks failed: " + ", ".join(failed))
    except Exception as error:  # cleanup policy is handled below
        failure = error
        report["error"] = str(error)
    finally:
        archive_errors: list[str] = []
        archives: dict[str, Any] = {}
        for role, machine in (("provider", provider), ("buyer", buyer)):
            if machine is None:
                continue
            archive_path = report_dir / f"{role}-state.tar.gz"
            try:
                archives[role] = _archive_state(fly, machine, archive_path)
            except Exception as error:
                archive_errors.append(f"{role}: {error}")
        report["archives"] = archives
        archive_complete = not archive_errors and len(archives) == len(machines)
        report["archive_complete"] = archive_complete
        if archive_errors:
            report["archive_errors"] = archive_errors
        cleanup_errors: list[str] = []
        known = {(r.kind, r.name) for r in [*machines, *volumes]}
        report["uncertain_resources"] = [i for i in report["resource_intents"] if (i["kind"], i["name"]) not in known]
        should_cleanup = (not args.keep) and archive_complete and not report["uncertain_resources"] and (terminal_confirmed or args.cleanup_on_error)
        if should_cleanup:
            for machine in reversed(machines):
                cleanup_errors.extend(fly.stop_destroy(machine))
            if not cleanup_errors:
                for volume in reversed(volumes):
                    error = fly.destroy_volume(volume)
                    if error:
                        cleanup_errors.append(error)
            report["cleanup"]["performed"] = True
            report["cleanup"]["app_retained"] = True
            if args.delete_app and created_app and not cleanup_errors:
                deleted = fly.run(["apps", "destroy", args.app, "--yes"], check=False, timeout=120)
                if deleted.returncode != 0:
                    cleanup_errors.append(f"destroy app {args.app}: {(deleted.stderr or deleted.stdout).strip()[-1000:]}")
                else:
                    report["cleanup"]["app_deleted"] = True
        else:
            report["cleanup"]["preserved_for_recovery"] = bool(failure and not terminal_confirmed)
            if args.keep:
                report["cleanup"]["reason"] = "--keep"
            elif not archive_complete:
                report["cleanup"]["reason"] = "state archive incomplete; resources remain for recovery"
            elif failure:
                report["cleanup"]["reason"] = "terminal Sui outcome was not confirmed; resources remain for recovery"
        report["cleanup"]["errors"] = cleanup_errors
        timing("finished")
        _write_private(report_path, json.dumps(report, indent=2) + "\n")

    print(json.dumps({
        "report": str(report_path),
        "app": args.app,
        "machines": report["machines"],
        "connection": report.get("connection"),
        "channel": report.get("channel"),
        "cleanup": report["cleanup"],
        "error": report.get("error"),
    }, indent=2))
    return (report, 1 if failure or report["cleanup"]["errors"] or not archive_complete else 0)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--app", required=True, help="new Fly app name")
    result.add_argument("--org", required=True, help="Fly organization slug")
    result.add_argument("--chain-config", required=True, help="public testnet chain.json")
    result.add_argument("--provider-state", required=True, help="pre-registered provider state directory")
    result.add_argument("--buyer-state", required=True, help="pre-registered buyer state directory")
    result.add_argument("--provider-gas", required=True, help="provider gas signer JSON")
    result.add_argument("--buyer-signer", required=True, help="buyer controller signer JSON")
    result.add_argument("--provider-region", default="iad")
    result.add_argument("--buyer-region", default="syd")
    result.add_argument("--path", choices=("relay", "direct"), default="relay",
                        help="relay forces Iroh relay-only; direct permits only globally routable IP routes")
    result.add_argument("--image", default=".", help="image reference, or . to build Dockerfile with Fly's builder")
    result.add_argument("--jobs", type=int, default=10)
    result.add_argument("--unit-price", type=int, default=1000)
    result.add_argument("--deposit", type=int, default=12000)
    result.add_argument("--work-ms", type=int, default=300_000)
    result.add_argument("--grace-ms", type=int, default=60_000)
    result.add_argument("--volume-size", type=int, default=1)
    result.add_argument("--session")
    result.add_argument("--run-id")
    result.add_argument("--report-dir", default=".m2m/fly-prep")
    result.add_argument("--command-timeout", type=int, default=240)
    result.add_argument("--reuse-app", action="store_true", help="allow an existing app; never delete it")
    result.add_argument("--keep", action="store_true", help="retain created Machines and volumes after a confirmed run")
    result.add_argument("--cleanup-on-error", action="store_true", help="destroy resources after an error, even without terminal confirmation")
    result.add_argument("--delete-app", action="store_true", help="delete the newly-created app after successful cleanup")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        _safe_name(args.app)
        _safe_name(args.org)
        _, status = run(args)
        return status
    except Exception as error:
        print(f"fly PoC was not started: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
