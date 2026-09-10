#!/usr/bin/env python3
"""Bounded end-to-end recovery matrix for the signed channel PoC.

This harness deliberately drives only the public channel CLI.  It keeps the
buyer/provider directories and role wallets supplied by the deployment under
the selected root, starts a fresh provider process for each phase, and never
removes a session or transaction journal.  The test matrix is intentionally
small enough for testnet while exercising the durable boundaries that are
easy to lose in a process restart.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


UNIT_PRICE = 1_000
DEFAULT_WORK_MS = 300_000
DEFAULT_GRACE_MS = 60_000
TIMER_WORK_MS = 30_000
TIMER_GRACE_MS = 30_000
CHANNEL_ACTIONS = {
    "channel_open",
    "channel_close",
    "channel_redeem",
    "channel_refund",
}


class HarnessError(RuntimeError):
    pass


class CommandResult:
    def __init__(self, command, returncode, stdout, stderr, value):
        self.command = command
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.value = value

    @property
    def ok(self):
        return self.returncode == 0


def integer(value, label):
    """Read the decimal-string or JSON-number form used by the CLI."""
    if type(value) is int:
        result = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        result = int(value)
        if str(result) != value:
            raise HarnessError(f"{label} is not a canonical integer: {value!r}")
    else:
        raise HarnessError(f"{label} is not an integer: {value!r}")
    if not 0 <= result < 2**64:
        raise HarnessError(f"{label} is outside u64")
    return result


def json_value(text, label):
    if not text.strip():
        raise HarnessError(f"{label} produced no JSON stdout")
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise HarnessError(f"{label} produced invalid JSON: {error}") from error


def tail(text, limit=4_000):
    return text[-limit:]


def safe_unlink(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


class ProviderProcess:
    def __init__(self, harness, case_name):
        self.harness = harness
        self.case_name = case_name
        self.process = None
        self.log = None
        self.generation = 0

    def start(self, fault=None):
        if self.process is not None and self.process.poll() is None:
            raise HarnessError("provider is already running")
        self.harness.provider_generation += 1
        self.generation = self.harness.provider_generation
        log_path = self.harness.log_dir / (
            f"{self.case_name}.provider-{self.generation}.log"
        )
        self.log = log_path.open("a", encoding="utf-8")
        command = [
            str(self.harness.binary),
            "--state", str(self.harness.provider_state),
            "channel-serve",
            "--file", str(self.harness.fixture),
            "--gas-signer", str(self.harness.provider_gas),
            "--ticket", str(self.harness.ticket),
            "--unit-price", str(UNIT_PRICE),
            "--max-jobs", "1000",
            "--work-ms", str(self.harness.work_ms),
            "--grace-ms", str(self.harness.grace_ms),
        ]
        command.extend(self.harness.relay_flags)
        if fault is not None:
            command.extend(["--fault", fault])
        started_ns = time.time_ns()
        self.process = subprocess.Popen(
            command,
            stdout=self.log,
            stderr=self.log,
            env=self.harness.environment,
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.log.flush()
                raise HarnessError(
                    f"provider exited before readiness (fault={fault!r}):\n"
                    f"{tail(self.log_path.read_text(encoding='utf-8', errors='replace'))}"
                )
            ready = self._ready_since(started_ns)
            if ready:
                return ready
            time.sleep(0.1)
        self.log.flush()
        raise HarnessError(
            f"provider readiness timed out (fault={fault!r}):\n"
            f"{tail(self.log_path.read_text(encoding='utf-8', errors='replace'))}"
        )

    @property
    def log_path(self):
        return self.harness.log_dir / (
            f"{self.case_name}.provider-{self.generation}.log"
        )

    def _ready_since(self, started_ns):
        if not self.harness.ticket.exists():
            return None
        try:
            if self.harness.ticket.stat().st_mtime_ns < started_ns:
                return None
            value = json.loads(self.harness.ticket.read_text(encoding="utf-8"))
            if value.get("version") != 1 or value.get("method") != "sui.channel.v1":
                raise HarnessError("provider wrote an invalid channel ticket")
            if not value.get("agent") or not value.get("endpoint"):
                raise HarnessError("provider ticket is missing its public endpoint")
            # stdout may be block buffered when redirected to a file, so the
            # atomically replaced ticket is the readiness signal.  Its mtime
            # check prevents a previous provider generation from qualifying.
            return value
        except FileNotFoundError:
            return None
        return None

    def stop(self):
        process = self.process
        if process is None:
            return
        try:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
        finally:
            if self.log is not None:
                self.log.flush()
                self.log.close()
            self.log = None
            self.process = None


class Harness:
    def __init__(self, args):
        self.repo = Path(__file__).resolve().parent.parent
        self.root = Path(args.root).resolve()
        self.binary = Path(args.binary).resolve() if args.binary else self.repo / "target/debug/m2m"
        self.fixture = self.repo / "fixtures/hello.txt"
        self.chain_file = self.root / "chain.json"
        self.buyer_state = self.root / "buyer"
        self.provider_state = self.root / "provider"
        self.buyer_controller = self.root / "buyer-controller.json"
        self.provider_controller = self.root / "provider-controller.json"
        self.provider_gas = self.root / "provider-gas.json"
        self.ticket = self.root / "channel-ticket.json"
        self.log_dir = self.root / "recovery"
        self.report_path = self.log_dir / "channel-recovery-report.json"
        self.work_ms = args.work_ms
        self.grace_ms = args.grace_ms
        self.relay_flags = ["--relay-only"] if args.relay_only else []
        self.testnet_subset = args.testnet_subset
        self.selected_cases = args.cases
        self.network = None
        self.environment = os.environ.copy()
        self.environment.pop("M2M_CHANNEL_RPC_DENY_FILE", None)
        self.provider = None
        self.provider_generation = 0
        self.results = []
        self.executed_cases = []
        self.active_session = None
        self.started_at = time.time()

    def prepare(self):
        if not self.root.exists():
            raise HarnessError(f"deployment root does not exist: {self.root}")
        if not self.chain_file.exists():
            raise HarnessError(f"missing deployment config: {self.chain_file}")
        if not self.binary.exists():
            raise HarnessError(f"missing CLI binary: {self.binary}; run cargo build first")
        if not self.fixture.exists():
            raise HarnessError(f"missing fixture: {self.fixture}")
        try:
            config = json.loads(self.chain_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise HarnessError(f"invalid chain config: {error}") from error
        self.network = config.get("network")
        if self.network not in ("localnet", "testnet"):
            raise HarnessError(f"unsupported network in chain.json: {self.network!r}")
        if self.network == "testnet" and not self.testnet_subset:
            raise HarnessError(
                "testnet recovery runs require --testnet-subset to make the bounded "
                "scope explicit"
            )
        if self.work_ms < 10_000 or self.grace_ms < 10_000:
            raise HarnessError("--work-ms and --grace-ms must each be at least 10000")
        if self.work_ms + self.grace_ms > 3_600_000:
            raise HarnessError("work plus grace horizon exceeds the channel bound")
        for path in (
            self.buyer_controller,
            self.provider_controller,
            self.provider_gas,
        ):
            if not path.exists():
                raise HarnessError(f"missing role wallet: {path}")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.ensure_role("buyer", self.buyer_state, self.buyer_controller)
        self.ensure_role("provider", self.provider_state, self.provider_controller)
        self.provider_id = self.identity(self.provider_state)["agent"]
        self.buyer_id = self.identity(self.buyer_state)["agent"]

    def ensure_role(self, role, state, signer):
        identity = state / "identity.json"
        if identity.exists():
            return
        self.run_cli(
            ["--state", str(state), "init", "--chain", str(self.chain_file),
             "--signer", str(signer)],
            f"init-{role}",
            require_success=True,
        )

    @staticmethod
    def identity(state):
        try:
            value = json.loads((state / "identity.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise HarnessError(f"invalid identity under {state}") from error
        if not value.get("agent"):
            raise HarnessError(f"identity under {state} has no Agent ID")
        return value

    def run_cli(self, args, label, require_success=False, env_extra=None, timeout=300):
        command = [str(self.binary)] + [str(value) for value in args]
        environment = self.environment.copy()
        if env_extra:
            environment.update(env_extra)
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=environment,
                cwd=self.repo,
            )
        except subprocess.TimeoutExpired as error:
            raise HarnessError(f"{label} timed out after {timeout}s") from error
        log_path = self.log_dir / f"{label}.cli.log"
        with log_path.open("a", encoding="utf-8") as log:
            log.write(json.dumps({"command": command, "returncode": result.returncode}) + "\n")
            if result.stdout:
                log.write("--- stdout ---\n" + result.stdout)
            if result.stderr:
                log.write("--- stderr ---\n" + result.stderr)
        value = None
        if result.stdout.strip():
            value = json_value(result.stdout, label)
        response = CommandResult(command, result.returncode, result.stdout, result.stderr, value)
        if require_success and not response.ok:
            raise HarnessError(
                f"{label} failed with exit {response.returncode}:\n{tail(response.stderr)}"
            )
        if response.ok and not isinstance(value, dict):
            raise HarnessError(f"{label} succeeded without a JSON object")
        return response

    def start_provider(self, case_name, fault=None):
        if self.provider is not None:
            raise HarnessError("provider handle already exists")
        self.provider = ProviderProcess(self, case_name)
        self.provider.start(fault=fault)

    def stop_provider(self):
        if self.provider is not None:
            self.provider.stop()
            self.provider = None

    def restart_provider(self, case_name, fault=None):
        self.stop_provider()
        self.start_provider(case_name, fault=fault)

    def buy(self, session, jobs, deposit, label, stop_after=None, close=True,
            env_extra=None, allow_failure=False):
        args = [
            "--state", str(self.buyer_state),
            "channel-buy",
            "--provider", self.provider_id,
            "--ticket", str(self.ticket),
            "--expected-file", str(self.fixture),
            "--signer", str(self.buyer_controller),
            "--session", session,
            "--jobs", str(jobs),
            "--deposit", str(deposit),
            "--max-unit-price", str(UNIT_PRICE),
        ]
        args.extend(self.relay_flags)
        if stop_after is not None:
            args.extend(["--stop-after", stop_after])
        if not close:
            args.append("--no-close")
        return self.run_cli(
            args, label, require_success=not allow_failure, env_extra=env_extra
        )

    def status(self, session, label):
        return self.run_cli(
            ["--state", str(self.buyer_state), "channel-status", "--session", session],
            label,
            require_success=True,
        ).value

    def close(self, session, label):
        return self.run_cli(
            ["--state", str(self.buyer_state), "channel-close", "--session", session,
             "--gas-signer", str(self.buyer_controller)],
            label,
            require_success=True,
        ).value

    def refund(self, session, label):
        return self.run_cli(
            ["--state", str(self.buyer_state), "channel-refund", "--session", session,
             "--gas-signer", str(self.buyer_controller)],
            label,
            require_success=True,
        ).value

    def session(self, session):
        path = self.buyer_state / "channels" / "sessions" / f"{session}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise HarnessError(f"missing or invalid buyer journal: {path}") from error

    def provider_journal(self, channel):
        path = self.provider_state / "channels" / "live" / f"{channel}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise HarnessError(f"missing or invalid provider journal: {path}") from error

    def tx_records(self):
        records = {}
        for role_state in (self.buyer_state, self.provider_state):
            tx_dir = role_state / "channels" / "tx"
            if not tx_dir.exists():
                continue
            for path in sorted(tx_dir.glob("*.tx.json")):
                try:
                    value = json.loads(path.read_text(encoding="utf-8"))
                except json.JSONDecodeError as error:
                    raise HarnessError(f"invalid transaction journal: {path}") from error
                action = value.get("action")
                if action not in CHANNEL_ACTIONS:
                    continue
                if value.get("state") != "confirmed":
                    continue
                digest = value.get("digest")
                if not digest:
                    for attempt in value.get("attempts", []):
                        if attempt.get("state") == "confirmed" and attempt.get("digest"):
                            digest = attempt["digest"]
                            break
                if not digest:
                    raise HarnessError(f"confirmed transaction has no digest: {path}")
                relative = str(path.relative_to(self.root))
                if digest in records:
                    if records[digest]["action"] != action:
                        raise HarnessError(f"transaction {digest} has conflicting journal actions")
                    records[digest]["paths"].append(relative)
                else:
                    records[digest] = {
                        "digest": digest,
                        "action": action,
                        "path": relative,
                        "paths": [relative],
                    }
        return records

    def scoped_records(self, records, session=None, channel=None):
        """A provider may recover old channels while this scenario is running."""
        session = session or self.active_session
        if not session:
            raise HarnessError("transaction accounting requires an active session")
        if channel is None:
            journal_path = self.buyer_state / "channels" / "sessions" / f"{session}.json"
            if journal_path.exists():
                channel = self.session(session).get("channel")
        buyer_prefix = f"buyer/channels/tx/{session}."
        provider_prefix = f"provider/channels/tx/{channel}." if channel else None
        return {
            digest: record for digest, record in records.items()
            if any(
                path.startswith(buyer_prefix) or
                (provider_prefix is not None and path.startswith(provider_prefix))
                for path in record.get("paths", [record["path"]])
            )
        }

    def require_boundary(self, response, label, boundary_text=None):
        if response.ok and isinstance(response.value, dict):
            if boundary_text is None:
                return
            if response.value.get("stopped") == boundary_text:
                return
            if boundary_text == "opened" and response.value.get("session"):
                # The opened stop is allowed to return only the session ID;
                # the buyer journal below is the durable boundary assertion.
                return
        if response.returncode == 0:
            raise HarnessError(
                f"{label} returned success without durable boundary {boundary_text!r}: "
                f"{response.value!r}"
            )
        # Accept the specific peer-injected close, never an unrelated RPC,
        # timeout, parser, or validation failure containing the word 'channel'.
        if not boundary_text or not boundary_text.startswith("after-") or \
                "injected channel fault" not in response.stderr.lower():
            raise HarnessError(
                f"{label} failed without the injected fault marker:\n{tail(response.stderr)}"
            )

    def require_job(self, value, sequence, completed=None, ack=None, result=None):
        jobs = value.get("jobs")
        if not isinstance(jobs, list):
            raise HarnessError("session journal jobs is not a list")
        matches = [job for job in jobs if integer(job.get("request", {}).get("request_sequence"), "job sequence") == sequence]
        if len(matches) != 1:
            raise HarnessError(f"expected exactly one saved job {sequence}, found {len(matches)}")
        job = matches[0]
        if completed is not None and bool(job.get("completed")) != completed:
            raise HarnessError(f"job {sequence} completed={job.get('completed')!r}, expected {completed}")
        if ack is not None and (job.get("ack") is not None) != ack:
            raise HarnessError(f"job {sequence} ack presence mismatch")
        if result is not None and (job.get("result") is not None) != result:
            raise HarnessError(f"job {sequence} result presence mismatch")
        return job

    def require_provider_job(self, value, sequence, result=None):
        jobs = value.get("jobs")
        matches = [job for job in jobs if integer(job.get("request", {}).get("request_sequence"), "provider job sequence") == sequence]
        if len(matches) != 1:
            raise HarnessError(f"expected exactly one provider job {sequence}, found {len(matches)}")
        if result is not None and (matches[0].get("result") is not None) != result:
            raise HarnessError(f"provider job {sequence} result presence mismatch")
        return matches[0]

    def require_open_session(self, session, channel=None):
        value = self.session(session)
        if not value.get("channel"):
            raise HarnessError(f"{session} has no recovered channel")
        if channel is not None and value["channel"] != channel:
            raise HarnessError(f"channel changed from {channel} to {value['channel']}")
        if value.get("frozen"):
            raise HarnessError(f"{session} unexpectedly froze before close")
        return value

    def require_preserved(self, previous, current, label):
        """Previously signed records and completed roots survive every restart."""
        for field in ("channel", "buyer", "provider", "offer", "terms", "opening_nonce"):
            if field in previous and previous[field] != current.get(field):
                raise HarnessError(f"{label} changed immutable {field}")
        if previous.get("frozen") and current.get("frozen") is not True:
            raise HarnessError(f"{label} unfroze a signed close")
        for field in ("close", "certificate"):
            if previous.get(field) is not None and previous[field] != current.get(field):
                raise HarnessError(f"{label} replaced the saved {field}")
        for old in previous["jobs"]:
            sequence = integer(old["request"]["request_sequence"], "saved sequence")
            new = self.require_job(current, sequence)
            for field in ("request", "credit", "ack", "result", "result_file", "transcript_after"):
                if old.get(field) is not None and old[field] != new.get(field):
                    raise HarnessError(f"{label} changed job {sequence} {field}")
            if old["completed"] and new["completed"] is not True:
                raise HarnessError(f"{label} reverted completed job {sequence}")

    def require_progress(self, session, channel, issued, completed, accepted,
                         provider_completed, label, frozen=False):
        """Check the exact boundary, including both roles' transcript prefixes."""
        buyer = self.session(session)
        provider = self.provider_journal(channel)
        if buyer.get("channel") != channel or provider.get("channel") != channel:
            raise HarnessError(f"{label} changed the channel")
        if buyer.get("frozen") is not frozen:
            raise HarnessError(f"{label} buyer freeze state differs from boundary")
        if buyer.get("offer") != provider.get("offer") or buyer.get("terms") != provider.get("terms"):
            raise HarnessError(f"{label} roles disagree on saved agreement")
        for role, journal, total, done in (
            ("buyer", buyer, issued, completed),
            ("provider", provider, accepted, provider_completed),
        ):
            records = journal.get("jobs")
            if not isinstance(records, list) or len(records) != total:
                raise HarnessError(f"{label} {role} must have exactly {total} jobs")
            for sequence in range(1, total + 1):
                job = self.require_job(journal, sequence, completed=sequence <= done)
                credit = job["credit"]["payload"]
                if integer(credit["sequence"], "credit sequence") != sequence or \
                        integer(credit["cumulative_amount"], "credit amount") != sequence * UNIT_PRICE:
                    raise HarnessError(f"{label} {role} credit increment is incorrect")
                if sequence > 1 and credit["previous_transcript_hash"] != \
                        self.require_job(journal, sequence - 1)["transcript_after"]:
                    raise HarnessError(f"{label} {role} advanced a transcript more than once")
            if done:
                root = self.require_job(journal, done)["transcript_after"]
                if not root or journal["transcript_hash"] != root:
                    raise HarnessError(f"{label} {role} root is not its completed prefix")
            if total > done and self.require_job(journal, done + 1)["credit"]["payload"]["previous_transcript_hash"] != journal["transcript_hash"]:
                raise HarnessError(f"{label} {role} pending credit changed its completed root")
        for sequence in range(1, min(issued, accepted) + 1):
            left = self.require_job(buyer, sequence)
            right = self.require_job(provider, sequence)
            for field in ("request", "credit", "ack", "result", "transcript_after"):
                if left.get(field) is not None and left[field] != right.get(field):
                    raise HarnessError(f"{label} roles disagree on job {sequence} {field}")
        if completed == provider_completed and buyer["transcript_hash"] != provider["transcript_hash"]:
            raise HarnessError(f"{label} equal completed counts have different roots")
        return buyer, provider

    def require_summary(self, response, channel, completed, authorized, label, phase="active"):
        value = response.value
        if not response.ok or not isinstance(value, dict) or value.get("phase") != phase or \
                value.get("terminal") is not False or value.get("channel") != channel:
            raise HarnessError(f"{label} has the wrong session summary: {value!r}")
        if integer(value.get("completed_jobs"), "completed_jobs") != completed or \
                integer(value.get("authorized"), "authorized") != authorized:
            raise HarnessError(f"{label} counts differ from the intended boundary: {value!r}")

    def cached_result(self, job):
        """Capture bytes and mtime so cached delivery cannot silently reexecute."""
        path = Path(job["result_file"])
        content = path.read_bytes()
        if json.loads(content) != list(self.fixture.read_bytes()):
            raise HarnessError(f"saved result differs from the fixture: {path}")
        return (content, path.stat().st_mtime_ns)

    def require_closed(self, session, expected_jobs, expected_amount, deposit, label):
        status = self.status(session, label + "-status")
        if status.get("phase") != "closed":
            raise HarnessError(f"{label} fresh status is not closed: {status!r}")
        if status.get("terminal") is not True:
            raise HarnessError(f"{label} fresh status is not terminal: {status!r}")
        session_value = self.session(session)
        if status.get("channel") != session_value.get("channel") or not status.get("channel"):
            raise HarnessError(f"{label} fresh status changed or omitted its channel: {status!r}")
        if not status.get("digest"):
            raise HarnessError(f"{label} fresh status omitted terminal digest: {status!r}")
        if integer(status.get("completed_jobs"), "completed_jobs") != expected_jobs:
            raise HarnessError(f"{label} completed job count mismatch: {status!r}")
        if integer(status.get("authorized"), "authorized") != expected_amount:
            raise HarnessError(f"{label} authorized amount mismatch: {status!r}")
        if integer(status.get("redeemed"), "redeemed") != expected_amount:
            raise HarnessError(f"{label} redeemed amount mismatch: {status!r}")
        if integer(status.get("residual"), "residual") != 0:
            raise HarnessError(f"{label} terminal residual is not zero: {status!r}")
        value = session_value
        state = value.get("chain_state") or {}
        if integer(state.get("funds", 0), "closed channel funds") != 0:
            raise HarnessError(f"{label} closed channel retains funds: {state!r}")
        offer = state.get("offer")
        if not isinstance(offer, dict):
            raise HarnessError(f"{label} fresh state omits its offer: {state!r}")
        if integer(offer.get("deposit"), "closed deposit") != deposit:
            raise HarnessError(f"{label} deposit changed: {state!r}")
        return status

    def require_refunded(self, session, expected_redeemed, label):
        status = self.status(session, label + "-status")
        if status.get("phase") != "refunded":
            raise HarnessError(f"{label} fresh status is not refunded: {status!r}")
        if status.get("terminal") is not True:
            raise HarnessError(f"{label} fresh status is not terminal: {status!r}")
        session_value = self.session(session)
        if status.get("channel") != session_value.get("channel") or not status.get("channel"):
            raise HarnessError(f"{label} fresh status changed or omitted its channel: {status!r}")
        if not status.get("digest"):
            raise HarnessError(f"{label} fresh status omitted terminal digest: {status!r}")
        if integer(status.get("redeemed"), "redeemed") != expected_redeemed:
            raise HarnessError(f"{label} redeemed amount mismatch: {status!r}")
        if integer(status.get("residual"), "residual") != 0:
            raise HarnessError(f"{label} refunded channel retains residual: {status!r}")
        value = session_value
        state = value.get("chain_state") or {}
        if integer(state.get("status"), "refunded status") != 2:
            raise HarnessError(f"{label} is not REFUNDED: {state!r}")
        if integer(state.get("funds"), "refunded channel funds") != 0:
            raise HarnessError(f"{label} refunded channel retains funds: {state!r}")
        return status

    def assert_repeat_no_new_tx(self, before, label):
        before = self.scoped_records(before)
        after = self.scoped_records(self.tx_records())
        if set(after) != set(before):
            added = sorted(set(after) - set(before))
            raise HarnessError(f"{label} submitted an extra transaction: {added}")

    def require_new_actions(self, before, expected, label):
        before = self.scoped_records(before)
        after = self.scoped_records(self.tx_records())
        added = [after[d]["action"] for d in sorted(set(after) - set(before))]
        if sorted(added) != sorted(expected):
            raise HarnessError(
                f"{label} journal transaction mismatch: expected {expected}, found {added}"
            )
        return after

    def new_session(self, prefix):
        for _ in range(20):
            session = f"recovery-{prefix}-{uuid.uuid4().hex[:10]}"
            if not (self.buyer_state / "channels" / "sessions" / f"{session}.json").exists():
                self.active_session = session
                return session
        raise HarnessError("could not allocate an unused session ID")

    def case(self, name, coverage, function):
        self.active_session = None
        before = self.tx_records()
        started = time.monotonic()
        try:
            details = function()
            after = self.tx_records()
            new = {d: after[d] for d in sorted(set(after) - set(before))}
            current = self.scoped_records(new)
            result = {
                "case": name,
                "coverage": coverage,
                "status": "passed",
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "new_transactions": list(current.values()),
                "unrelated_transactions": [record for d, record in new.items() if d not in current],
            }
            if details:
                result["details"] = details
            self.results.append(result)
            return result
        except Exception as error:
            failed = {
                "case": name,
                "coverage": coverage,
                "status": "failed",
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "error": str(error),
            }
            # Preserve observable activity even if a later boundary assertion
            # fails. Unrelated provider recovery is not charged to this case.
            try:
                after = self.tx_records()
                new = {d: after[d] for d in sorted(set(after) - set(before))}
                current = self.scoped_records(new) if self.active_session else {}
                failed["session"] = self.active_session
                failed["new_transactions"] = list(current.values())
                failed["unrelated_transactions"] = [r for d, r in new.items() if d not in current]
            except Exception as accounting_error:
                failed["accounting_error"] = str(accounting_error)
            self.results.append(failed)
            raise

    def case_buyer_boundaries(self):
        """C04/C09/C10/C13/C17/C18 on one channel and four jobs."""
        case_before = self.tx_records()
        session = self.new_session("buyer-boundaries")
        jobs = 4
        deposit = 5_000
        self.start_provider("buyer-boundaries")
        try:
            opened = self.buy(session, jobs, deposit, "buyer-opened", stop_after="opened")
            self.require_boundary(opened, "buyer-opened", "opened")
            value = self.require_open_session(session)
            channel = value["channel"]
            if value.get("jobs"):
                raise HarnessError("opened boundary already contains a job")
            before_bytes = (self.buyer_state / "channels" / "sessions" / f"{session}.json").read_bytes()
            before_tx = self.tx_records()

            deny_file = self.log_dir / f"{session}.rpc-deny"
            deny_file.write_text("deny", encoding="utf-8")
            try:
                denied = self.buy(
                    session, jobs, deposit, "buyer-admission-denied", close=False,
                    env_extra={"M2M_CHANNEL_RPC_DENY_FILE": str(deny_file)},
                    allow_failure=True,
                )
            finally:
                safe_unlink(deny_file)
            if denied.ok or "deny" not in denied.stderr.lower():
                raise HarnessError(
                    "admission RPC outage was not rejected at the counting transport"
                )
            after_bytes = (self.buyer_state / "channels" / "sessions" / f"{session}.json").read_bytes()
            if self.session(session).get("channel") != channel:
                raise HarnessError("admission RPC failure changed the channel")
            self.assert_repeat_no_new_tx(before_tx, "admission RPC failure")
            # The runtime may durably derive T0 immediately before admission;
            # all economic and signed job state must still be byte-for-byte stable.
            before = json.loads(before_bytes)
            after = json.loads(after_bytes)
            for field in ("opening_nonce", "offer", "channel", "jobs", "frozen", "close", "certificate"):
                if before.get(field) != after.get(field):
                    raise HarnessError(f"admission outage changed durable field {field}")

            self.restart_provider("buyer-boundaries")
            credit_stop = self.buy(
                session, jobs, deposit, "buyer-credit-saved", stop_after="credit-saved", close=False
            )
            self.require_boundary(credit_stop, "buyer-credit-saved", "credit-saved")
            self.require_summary(credit_stop, channel, 0, 1_000, "credit-saved")
            credit_buyer, credit_provider = self.require_progress(
                session, channel, 1, 0, 0, 0, "credit-saved"
            )
            self.require_job(credit_buyer, 1, completed=False, ack=False, result=False)

            # A resume completes the pending job before applying a stop to the
            # next NEW job. --no-close alone would finish every remaining job.
            self.restart_provider("buyer-boundaries")
            ack_stop = self.buy(
                session, jobs, deposit, "buyer-acknowledged", stop_after="acknowledged", close=False
            )
            self.require_boundary(ack_stop, "buyer-acknowledged", "acknowledged")
            self.require_summary(ack_stop, channel, 1, 2_000, "acknowledged")
            ack_buyer, ack_provider = self.require_progress(
                session, channel, 2, 1, 2, 1, "acknowledged"
            )
            self.require_preserved(credit_buyer, ack_buyer, "buyer credit replay")
            self.require_preserved(credit_provider, ack_provider, "provider credit replay")
            self.require_job(ack_buyer, 1, completed=True, ack=True, result=True)
            self.require_job(ack_buyer, 2, completed=False, ack=True, result=False)
            transcript_after_one = ack_buyer["transcript_hash"]

            self.restart_provider("buyer-boundaries")
            result_stop = self.buy(
                session, jobs, deposit, "buyer-result-saved", stop_after="result-saved", close=False
            )
            self.require_boundary(result_stop, "buyer-result-saved", "result-saved")
            self.require_summary(result_stop, channel, 2, 3_000, "result-saved")
            result_buyer, result_provider = self.require_progress(
                session, channel, 3, 2, 3, 3, "result-saved"
            )
            self.require_preserved(ack_buyer, result_buyer, "buyer acknowledged replay")
            self.require_preserved(ack_provider, result_provider, "provider acknowledged replay")
            third = self.require_job(result_buyer, 3, completed=False, ack=True, result=True)
            third_provider = self.require_provider_job(result_provider, 3, result=True)
            buyer_cache = self.cached_result(third)
            provider_cache = self.cached_result(third_provider)
            saved_third_root = result_provider["transcript_hash"]

            # Normal resume completes the saved third result and the fourth job.
            # Check the third job's root against T3, not the final session's T4.
            self.restart_provider("buyer-boundaries")
            resumed = self.buy(session, jobs, deposit, "buyer-resume-result", close=False)
            self.require_summary(resumed, channel, 4, 4_000, "result resume")
            value, provider_value = self.require_progress(
                session, channel, 4, 4, 4, 4, "result resume"
            )
            self.require_preserved(result_buyer, value, "buyer result replay")
            self.require_preserved(result_provider, provider_value, "provider result replay")
            third = self.require_job(value, 3, completed=True, ack=True, result=True)
            if third["transcript_after"] != saved_third_root:
                raise HarnessError("saved third result did not finalize to its exact provider root")
            if self.cached_result(third) != buyer_cache or \
                    self.cached_result(self.require_provider_job(provider_value, 3)) != provider_cache:
                raise HarnessError("saved result files were rewritten during restart recovery")
            completed_buyer, completed_provider = value, provider_value

            self.restart_provider("buyer-boundaries")
            close_stop = self.buy(
                session, jobs, deposit, "buyer-close-signed", stop_after="close-signed"
            )
            self.require_boundary(close_stop, "buyer-close-signed", "close-signed")
            value = self.session(session)
            if not value.get("frozen") or value.get("certificate") is not None:
                raise HarnessError("close-signed boundary did not leave one frozen candidate")
            self.require_preserved(completed_buyer, value, "buyer close freeze")
            signed_buyer = value

            self.restart_provider("buyer-boundaries")
            certificate_stop = self.buy(
                session, jobs, deposit, "buyer-close-certificate", stop_after="close-certificate"
            )
            self.require_boundary(certificate_stop, "buyer-close-certificate", "close-certificate")
            value = self.session(session)
            if not value.get("certificate"):
                raise HarnessError("close-certificate boundary did not persist certificate")
            self.require_preserved(signed_buyer, value, "buyer frozen close resume")
            provider_value = self.provider_journal(channel)
            self.require_preserved(completed_provider, provider_value, "provider close freeze")
            if not provider_value.get("frozen") or provider_value["certificate"] != value["certificate"]:
                raise HarnessError("close resume did not retain the same certificate in both roles")
            certificate_buyer, certificate_provider = value, provider_value

            self.restart_provider("buyer-boundaries")
            self.close(session, "buyer-close-submit")
            before_repeat = self.tx_records()
            self.close(session, "buyer-close-repeat")
            self.assert_repeat_no_new_tx(before_repeat, "repeated close")
            before_repeat = self.tx_records()
            self.buy(session, jobs, deposit, "buyer-buy-repeat")
            self.assert_repeat_no_new_tx(before_repeat, "repeated closed buy")
            self.require_closed(session, jobs, 4_000, deposit, "buyer-boundaries")
            self.require_preserved(certificate_buyer, self.session(session), "buyer terminal replay")
            self.require_preserved(certificate_provider, self.provider_journal(channel), "provider terminal replay")
            self.require_new_actions(case_before, ["channel_open", "channel_close"], "buyer-boundaries")
            return {
                "session": session,
                "channel": channel,
                "completed_jobs": 4,
                "transcript_after_one": transcript_after_one,
            }
        finally:
            self.stop_provider()

    def case_provider_faults(self):
        """C09/C10/C13 with one channel and three injected reply losses."""
        case_before = self.tx_records()
        session = self.new_session("provider-faults")
        jobs = 3
        deposit = 4_000
        self.start_provider("provider-faults", fault="after-credit")
        try:
            first = self.buy(
                session, jobs, deposit, "fault-after-credit", close=False, allow_failure=True
            )
            self.require_boundary(first, "fault-after-credit", "after-credit")
            channel = self.session(session).get("channel")
            if not channel:
                raise HarnessError("after-credit fault did not retain channel")
            credit_buyer, credit_provider = self.require_progress(
                session, channel, 1, 0, 1, 0, "lost credit Ack"
            )
            first_job = self.require_job(credit_buyer, 1, completed=False, ack=False, result=False)
            provider_job = self.require_provider_job(credit_provider, 1, result=False)
            if provider_job["credit"] != first_job["credit"] or provider_job.get("ack") is None:
                raise HarnessError("after-credit fault lost provider credit or Ack")

            self.restart_provider("provider-faults")
            second_ack = self.buy(
                session, jobs, deposit, "fault-resume-credit", close=False,
                stop_after="acknowledged",
            )
            self.require_boundary(second_ack, "fault-resume-credit", "acknowledged")
            self.require_summary(second_ack, channel, 1, 2_000, "fault credit resume")
            ack_buyer, ack_provider = self.require_progress(
                session, channel, 2, 1, 2, 1, "second credit acknowledged"
            )
            self.require_preserved(credit_buyer, ack_buyer, "buyer lost Ack recovery")
            self.require_preserved(credit_provider, ack_provider, "provider lost Ack recovery")
            self.require_job(ack_buyer, 1, completed=True, ack=True, result=True)
            self.require_job(ack_buyer, 2, completed=False, ack=True, result=False)

            self.restart_provider("provider-faults", fault="after-result")
            second = self.buy(
                session, jobs, deposit, "fault-after-result", close=False, allow_failure=True
            )
            self.require_boundary(second, "fault-after-result", "after-result")
            result_buyer, result_provider = self.require_progress(
                session, channel, 2, 1, 2, 2, "lost second result"
            )
            self.require_preserved(ack_buyer, result_buyer, "buyer lost result")
            self.require_preserved(ack_provider, result_provider, "provider lost result")
            second_job = self.require_job(result_buyer, 2, completed=False, ack=True, result=False)
            provider_job = self.require_provider_job(result_provider, 2, result=True)
            if provider_job["credit"] != second_job["credit"]:
                raise HarnessError("after-result fault changed the saved credit")
            second_root = result_provider["transcript_hash"]
            provider_cache = self.cached_result(provider_job)

            self.restart_provider("provider-faults")
            resumed = self.buy(session, jobs, deposit, "fault-resume-result", close=False)
            self.require_summary(resumed, channel, 3, 3_000, "lost result resume")
            completed_buyer, completed_provider = self.require_progress(
                session, channel, 3, 3, 3, 3, "lost result resume"
            )
            self.require_preserved(result_buyer, completed_buyer, "buyer cached result replay")
            self.require_preserved(result_provider, completed_provider, "provider cached result replay")
            # Recovery fetches T2's cached result, then a new job advances to T3.
            # The provider's saved T2 and file must remain exactly unchanged.
            if self.require_job(completed_buyer, 2)["transcript_after"] != second_root or \
                    self.cached_result(self.require_provider_job(completed_provider, 2)) != provider_cache:
                raise HarnessError("cached second result or its completed transcript was replaced")

            self.restart_provider("provider-faults", fault="after-close-certificate")
            close_lost = self.buy(
                session, jobs, deposit, "fault-after-close-certificate", allow_failure=True
            )
            self.require_boundary(close_lost, "fault-after-close-certificate", "after-close-certificate")
            value = self.session(session)
            if not value.get("frozen") or value.get("certificate") is not None:
                raise HarnessError("lost close certificate did not leave buyer frozen without cert")
            provider_value = self.provider_journal(channel)
            if not provider_value.get("certificate"):
                raise HarnessError("provider did not retain close certificate before dropping reply")
            self.require_preserved(completed_buyer, value, "buyer lost close certificate")
            self.require_preserved(completed_provider, provider_value, "provider lost close certificate")
            if not provider_value.get("frozen"):
                raise HarnessError("provider failed to freeze before dropping close certificate")
            frozen_buyer, frozen_provider = value, provider_value

            self.restart_provider("provider-faults")
            self.buy(session, jobs, deposit, "fault-resume-close")
            self.require_closed(session, jobs, 3_000, deposit, "provider-faults")
            self.require_preserved(frozen_buyer, self.session(session), "buyer close recovery")
            self.require_preserved(frozen_provider, self.provider_journal(channel), "provider close recovery")
            if self.session(session)["certificate"] != frozen_provider["certificate"]:
                raise HarnessError("close recovery replaced the provider's saved certificate")
            before_repeat = self.tx_records()
            self.buy(session, jobs, deposit, "fault-repeat-closed")
            self.assert_repeat_no_new_tx(before_repeat, "repeated fault session")
            self.require_new_actions(case_before, ["channel_open", "channel_close"], "provider-faults")
            return {"session": session, "channel": channel, "completed_jobs": 3}
        finally:
            self.stop_provider()

    def wait_for_redeem(self, channel, deadline):
        end = time.monotonic() + ((self.work_ms + self.grace_ms) / 1000) + 30
        while time.monotonic() < end:
            if self.provider is None or self.provider.process.poll() is not None:
                raise HarnessError("provider stopped before scheduled recovery completed")
            records = self.scoped_records(self.tx_records(), channel=channel)
            if any(record["action"] == "channel_redeem" for record in records.values()):
                return records
            time.sleep(0.5)
        raise HarnessError(
            f"scheduled redemption was not confirmed before claim horizon; deadline={deadline}"
        )

    def case_timer_recovery(self):
        """C15/C16/C17: redeem a saved credit with no further peer request."""
        case_before = self.tx_records()
        original_horizon = (self.work_ms, self.grace_ms)
        self.work_ms = TIMER_WORK_MS
        self.grace_ms = TIMER_GRACE_MS
        session = self.new_session("timer-recovery")
        deposit = 2_000
        deny_file = self.root / f"{session}.recovery-rpc-deny"
        rpc_failure_observed = False
        try:
            self.start_provider("timer-recovery", fault="after-credit")
            failed = self.buy(
                session, 1, deposit, "timer-credit-lost", close=False, allow_failure=True
            )
            self.require_boundary(failed, "timer-credit-lost", "after-credit")
            value = self.session(session)
            channel = value.get("channel")
            if not channel:
                raise HarnessError("timer case has no channel")
            self.require_job(value, 1, completed=False, ack=False, result=False)
            offer = value.get("offer", {}).get("payload", {})
            claim_deadline = integer(offer.get("claim_deadline_ms"), "claim deadline")
            provider_before = self.provider_journal(channel)
            saved_credit = self.require_provider_job(provider_before, 1, result=False)["credit"]
            # Inject a real RPC outage through the first scheduled recovery
            # attempt. Remove it only after observing an actual denied call.
            if '"event":"channel_request"' not in self.provider.log_path.read_text():
                raise HarnessError("provider request telemetry is unavailable")
            self.stop_provider()
            log_path = self.log_dir / f"timer-recovery.provider-{self.provider_generation + 1}.log"
            log_offset = len(log_path.read_text()) if log_path.exists() else 0
            if self.network == "localnet":
                deny_file.write_text("scheduled recovery outage\n")
                deny_file.chmod(0o600)
                self.environment["M2M_CHANNEL_RPC_DENY_FILE"] = str(deny_file)
            self.start_provider("timer-recovery")
            if self.network == "localnet":
                until = time.monotonic() + TIMER_WORK_MS / 1000 + 15
                while time.monotonic() < until:
                    lines = self.provider.log_path.read_text()[log_offset:].splitlines()
                    events = []
                    for line in lines:
                        try:
                            events.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
                    if any(e.get("event") == "channel_recovery" and
                           e.get("channel") == channel and e.get("result") == "unknown" and
                           "M2M_CHANNEL_RPC_DENY_FILE denied" in e.get("message", "")
                           for e in events):
                        rpc_failure_observed = True
                        break
                    time.sleep(0.2)
                if not rpc_failure_observed:
                    raise HarnessError("scheduled recovery never attempted RPC during injected outage")
                safe_unlink(deny_file)
                self.environment.pop("M2M_CHANNEL_RPC_DENY_FILE", None)

            # No buyer or peer request is made after this point.  The only
            # activity that can settle the advance is provider_recovery's timer.
            records = self.wait_for_redeem(channel, claim_deadline)
            value = self.status(session, "timer-after-redeem")
            if value.get("channel") != channel or value.get("phase") not in ("active", "frozen") or \
                    value.get("terminal") is not False or \
                    integer(value.get("completed_jobs"), "timer completed") != 0 or \
                    integer(value.get("authorized"), "timer authorized") != UNIT_PRICE or \
                    integer(value.get("redeemed"), "timer redeemed") != UNIT_PRICE or \
                    integer(value.get("residual"), "timer residual") != deposit - UNIT_PRICE:
                raise HarnessError(f"scheduled redemption paid the wrong amount: {value!r}")
            provider_after = self.provider_journal(channel)
            if self.require_provider_job(provider_after, 1)["credit"] != saved_credit:
                raise HarnessError("scheduled redemption changed the saved credit")
            log_text = self.provider.log_path.read_text(encoding="utf-8", errors="replace")
            if '"event":"channel_recovery"' not in log_text:
                raise HarnessError("scheduled redemption has no channel_recovery evidence")
            peer_requests = 0
            for line in log_text[log_offset:].splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("event") == "channel_request":
                    peer_requests += 1
            if peer_requests:
                raise HarnessError("timer recovery received peer requests after restart")
            self.stop_provider()

            wait_ms = max(0, claim_deadline - int(time.time() * 1000)) + 5_000
            if wait_ms:
                time.sleep(wait_ms / 1000)
            refunded = self.refund(session, "timer-refund")
            self.require_refunded(session, UNIT_PRICE, "timer-recovery")
            before_repeat = self.tx_records()
            self.refund(session, "timer-refund-repeat")
            self.assert_repeat_no_new_tx(before_repeat, "repeated residual refund")
            if not any(record["action"] == "channel_redeem" for record in records.values()):
                raise HarnessError("timer case has no redemption transaction")
            self.require_new_actions(
                case_before,
                ["channel_open", "channel_redeem", "channel_refund"],
                "timer-recovery",
            )
            return {
                "session": session,
                "channel": channel,
                "redeemed": UNIT_PRICE,
                "peer_requests_after_credit": peer_requests,
                "scheduled_rpc_failure_then_retry": rpc_failure_observed,
            }
        finally:
            self.stop_provider()
            safe_unlink(deny_file)
            self.environment.pop("M2M_CHANNEL_RPC_DENY_FILE", None)
            self.work_ms, self.grace_ms = original_horizon

    def case_zero_job_close(self):
        """C16: open and cooperatively close without issuing a credit."""
        case_before = self.tx_records()
        session = self.new_session("zero-job")
        deposit = UNIT_PRICE
        self.start_provider("zero-job")
        try:
            opened = self.buy(
                session, 1, deposit, "zero-job-opened", stop_after="opened", close=False
            )
            self.require_boundary(opened, "zero-job-opened", "opened")
            result = self.close(session, "zero-job-close")
            value = self.session(session)
            if value.get("jobs"):
                raise HarnessError("zero-job close issued an unexpected credit")
            self.require_closed(session, 0, 0, deposit, "zero-job")
            before_repeat = self.tx_records()
            self.close(session, "zero-job-repeat")
            self.assert_repeat_no_new_tx(before_repeat, "repeated zero-job close")
            self.require_new_actions(case_before, ["channel_open", "channel_close"], "zero-job")
            return {"session": session, "channel": value.get("channel"), "completed_jobs": 0}
        finally:
            self.stop_provider()

    def run(self):
        self.prepare()
        default_cases = ["buyer-boundaries", "provider-faults", "timer-recovery"]
        if self.network == "localnet" and not self.testnet_subset:
            default_cases.append("zero-job-close")
        cases = list(dict.fromkeys(self.selected_cases or default_cases))
        if "zero-job-close" in cases and self.network != "localnet":
            raise HarnessError("zero-job-close is a localnet-only case")
        self.executed_cases = cases
        definitions = {
            "buyer-boundaries": (
                ["C04", "C09", "C10", "C13", "C17", "C18"],
                self.case_buyer_boundaries,
            ),
            "provider-faults": (["C09", "C10", "C13"], self.case_provider_faults),
            "timer-recovery": (["C15", "C16", "C17"], self.case_timer_recovery),
            "zero-job-close": (["C16"], self.case_zero_job_close),
        }
        for name in cases:
            coverage, function = definitions[name]
            self.case(name, coverage, function)

    def write_report(self, error=None):
        report = {
            "version": 1,
            "network": self.network,
            "root": str(self.root),
            "relay_only": bool(self.relay_flags),
            "work_ms": self.work_ms,
            "grace_ms": self.grace_ms,
            "testnet_subset": self.testnet_subset,
            "selected_cases": self.executed_cases,
            "cases": self.results,
            "status": "failed" if error else "passed",
            "elapsed_ms": round((time.time() - self.started_at) * 1000),
        }
        if error:
            report["error"] = str(error)
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        self.report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        try:
            self.report_path.chmod(0o600)
        except OSError:
            pass
        return report


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Run the bounded signed-channel recovery matrix on an existing deployment"
    )
    parser.add_argument("--root", default=".m2m/channels-local")
    parser.add_argument("--binary", help="m2m binary (default: target/debug/m2m)")
    parser.add_argument("--relay-only", action="store_true")
    parser.add_argument("--case", dest="cases", action="append",
                        choices=["buyer-boundaries", "provider-faults", "timer-recovery", "zero-job-close"],
                        help="run one named scenario; repeat for multiple cases (default: full suite)")
    parser.add_argument("--testnet-subset", action="store_true",
                        help="make the reduced testnet scope explicit; omit local-only zero-job case")
    parser.add_argument("--work-ms", type=int, default=DEFAULT_WORK_MS)
    parser.add_argument("--grace-ms", type=int, default=DEFAULT_GRACE_MS)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    harness = Harness(args)
    error = None
    try:
        harness.run()
    except Exception as caught:
        error = caught
    finally:
        harness.stop_provider()
        report = harness.write_report(error)
    print(json.dumps({
        "status": report["status"],
        "network": report["network"],
        "cases": report["cases"],
        "report": str(harness.report_path),
    }, indent=2))
    if error:
        print(f"channel recovery failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
