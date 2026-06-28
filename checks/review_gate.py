#!/usr/bin/env python3
"""Evaluate Pilot's ordered review gate evidence.

The gate is intentionally offline. `workflow.yaml` is the policy source of
truth; evidence supplies facts and report outputs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from specrail_lib import SpecRailError, artifact_templates, load_pack, work_id_for_issue


PASS_STATUSES = {"PASS", "PASSED"}
SKIP_STATUSES = {"SKIPPED", "NOT_APPLICABLE", "N/A"}
FINAL_AUTHORITY_BLOCKS = {"final_approval", "merge"}


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read evidence file {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid evidence JSON {path}: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("review gate evidence must be an object")
    return data


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def _non_negative_int(value: Any) -> bool:
    return type(value) is int and value >= 0


def _norm(value: Any) -> str:
    return str(value or "").strip().rstrip(".").upper()


def _review_gate_policy(config: Any) -> dict[str, Any]:
    policy = config.workflow.get("review_gate")
    if not isinstance(policy, dict):
        raise SpecRailError("workflow.yaml review_gate must be a mapping")
    stages = policy.get("stages")
    if not isinstance(stages, dict) or not stages:
        raise SpecRailError("workflow.yaml review_gate.stages must be a non-empty mapping")
    return policy


def _ordered_stage_policies(policy: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    stages = policy["stages"]
    ordered: list[tuple[int, str, dict[str, Any]]] = []
    for stage_name, stage_policy in stages.items():
        if not isinstance(stage_policy, dict):
            raise SpecRailError(f"workflow.yaml review_gate.stages.{stage_name} must be a mapping")
        order = stage_policy.get("order")
        if not _positive_int(order):
            raise SpecRailError(f"workflow.yaml review_gate.stages.{stage_name}.order must be a positive integer")
        ordered.append((order, str(stage_name), stage_policy))
    ordered.sort(key=lambda item: item[0])
    return [(stage_name, stage_policy) for _, stage_name, stage_policy in ordered]


def _conditions(evidence: dict[str, Any]) -> tuple[dict[str, bool], list[str], list[str]]:
    raw_conditions = evidence.get("conditions")
    if not isinstance(raw_conditions, dict):
        return {}, ["conditions"], []
    conditions: dict[str, bool] = {}
    reasons: list[str] = []
    for key, value in raw_conditions.items():
        if not isinstance(key, str) or not key.strip():
            reasons.append("condition keys must be non-empty strings")
            continue
        if not isinstance(value, bool):
            reasons.append(f"conditions.{key} must be boolean")
            continue
        conditions[key] = value
    return conditions, [], reasons


def _stage_required(
    stage_name: str,
    stage_policy: dict[str, Any],
    conditions: dict[str, bool],
) -> tuple[bool, list[str]]:
    missing: list[str] = []
    required_when = stage_policy.get("required_when", [])
    if not isinstance(required_when, list):
        return False, [f"workflow.yaml review_gate.stages.{stage_name}.required_when"]
    required = False
    for raw_condition in required_when:
        condition = str(raw_condition)
        if condition not in conditions:
            missing.append(f"conditions.{condition}")
            continue
        required = required or conditions[condition]
    return required, missing


def _render_artifact_template(template: str, pr: int, linked_issue: int | None) -> str:
    return (
        template.replace("{pr_number}", str(pr))
        .replace("{issue_number}", str(linked_issue) if linked_issue is not None else "")
        .replace("{work_id}", work_id_for_issue(linked_issue) or "")
    )


def _expected_artifact_path(
    config: Any,
    stage_name: str,
    stage_policy: dict[str, Any],
    pr: int,
    linked_issue: int | None,
) -> str | None:
    artifact_key = stage_policy.get("artifact")
    if not _non_empty_string(artifact_key):
        return None
    template = artifact_templates(config).get(str(artifact_key))
    if template is None:
        return None
    return _render_artifact_template(template, pr, linked_issue)


def _artifact_item(
    repo: Path,
    stage_name: str,
    stage: dict[str, Any],
    expected_artifact: str | None,
    *,
    allow_fixture_artifacts: bool,
) -> tuple[list[str], list[str], list[str]]:
    artifact = stage.get("artifact")
    if not _non_empty_string(artifact):
        return [], [f"stages.{stage_name}.artifact"], []
    artifact_path = Path(str(artifact))
    if artifact_path.is_absolute() or ".." in artifact_path.parts:
        return [], [], [f"stages.{stage_name}.artifact must be a relative repository path"]
    if expected_artifact is None:
        return [], [], [f"workflow.yaml review_gate.stages.{stage_name}.artifact is not configured"]
    if str(artifact) != expected_artifact and not allow_fixture_artifacts:
        return [], [], [
            f"stages.{stage_name}.artifact must be {expected_artifact}; got {artifact}"
        ]
    if not (repo / artifact_path).is_file():
        return [], [f"artifact:{artifact}"], []
    if str(artifact) == expected_artifact:
        return [f"{stage_name} artifact: {artifact}"], [], []
    return [f"{stage_name} fixture artifact: {artifact}"], [], []


def _skip_item(stage_name: str, stage: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    reason = stage.get("reason")
    status = _norm(stage.get("status"))
    if status and status not in SKIP_STATUSES:
        return [], [], [f"stages.{stage_name}.status must be SKIPPED or NOT_APPLICABLE when not required"]
    if not _non_empty_string(reason):
        return [], [f"stages.{stage_name}.reason"], []
    return [f"{stage_name} not required: {reason}"], [], []


def _report_result_pass(stage_name: str, stage: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    status = _norm(stage.get("status"))
    if status in PASS_STATUSES:
        return [f"{stage_name} PASS"], [], []
    if status in {"FAIL", "FAILED"}:
        return [], [], [f"{stage_name} failed"]
    return [], [f"stages.{stage_name}.status"], []


def _rating_pass(
    stage_name: str,
    stage: dict[str, Any],
    stage_policy: dict[str, Any],
) -> tuple[list[str], list[str], list[str]]:
    satisfied: list[str] = []
    missing: list[str] = []
    reasons: list[str] = []

    passing_ratings = {_norm(value) for value in stage_policy.get("passing_ratings", [])}
    blocking_ratings = {_norm(value) for value in stage_policy.get("blocking_ratings", [])}
    if not passing_ratings:
        reasons.append(f"workflow.yaml review_gate.stages.{stage_name}.passing_ratings is empty")
    if not blocking_ratings:
        reasons.append(f"workflow.yaml review_gate.stages.{stage_name}.blocking_ratings is empty")

    rating = _norm(stage.get("rating"))
    if not rating:
        missing.append(f"stages.{stage_name}.rating")
    elif rating in blocking_ratings:
        reasons.append(f"{stage_name} blocking rating: {stage.get('rating')}")
    elif rating in passing_ratings:
        satisfied.append(f"{stage_name} rating: {stage.get('rating')}")
    else:
        reasons.append(f"{stage_name} rating is not recognized: {stage.get('rating')!r}")

    blocking_findings = stage.get("blocking_findings")
    if not _non_negative_int(blocking_findings):
        missing.append(f"stages.{stage_name}.blocking_findings")
    elif blocking_findings == 0:
        satisfied.append(f"{stage_name} has no blocking findings")
    else:
        reasons.append(f"{stage_name} has {blocking_findings} blocking findings")

    return satisfied, missing, reasons


def _evaluate_required_stage(
    stage_name: str,
    stage: dict[str, Any],
    stage_policy: dict[str, Any],
) -> tuple[list[str], list[str], list[str]]:
    pass_condition = stage_policy.get("pass_condition")
    if pass_condition == "report_result_pass":
        return _report_result_pass(stage_name, stage)
    if pass_condition == "rating_applied_or_looks_reasonable_with_no_blocking_findings":
        return _rating_pass(stage_name, stage, stage_policy)
    return [], [], [f"unsupported pass_condition for {stage_name}: {pass_condition!r}"]


def _stage_items(
    repo: Path,
    config: Any,
    stages: Any,
    stage_name: str,
    stage_policy: dict[str, Any],
    required: bool,
    pr: int,
    linked_issue: int | None,
    *,
    allow_fixture_artifacts: bool,
) -> tuple[list[str], list[str], list[str], set[str]]:
    satisfied: list[str] = []
    missing: list[str] = []
    reasons: list[str] = []
    blocked_actions = set(FINAL_AUTHORITY_BLOCKS)

    if not isinstance(stages, dict):
        return [], ["stages"], ["stages must be an object"], blocked_actions
    stage = stages.get(stage_name)
    if not isinstance(stage, dict):
        return [], [f"stages.{stage_name}"], [], blocked_actions

    if not required:
        skip_satisfied, skip_missing, skip_reasons = _skip_item(stage_name, stage)
        return skip_satisfied, skip_missing, skip_reasons, blocked_actions

    expected_artifact = _expected_artifact_path(config, stage_name, stage_policy, pr, linked_issue)
    artifact_satisfied, artifact_missing, artifact_reasons = _artifact_item(
        repo,
        stage_name,
        stage,
        expected_artifact,
        allow_fixture_artifacts=allow_fixture_artifacts,
    )
    satisfied.extend(artifact_satisfied)
    missing.extend(artifact_missing)
    reasons.extend(artifact_reasons)

    check_satisfied, check_missing, check_reasons = _evaluate_required_stage(
        stage_name,
        stage,
        stage_policy,
    )
    satisfied.extend(check_satisfied)
    missing.extend(check_missing)
    reasons.extend(check_reasons)

    if check_missing or check_reasons or artifact_missing or artifact_reasons:
        raw_blocks = stage_policy.get("blocks_on_fail", [])
        if isinstance(raw_blocks, list):
            blocked_actions.update(str(action) for action in raw_blocks)
    return satisfied, missing, reasons, blocked_actions


def evaluate_review_gate(
    repo: Path,
    evidence: dict[str, Any],
    *,
    allow_fixture_artifacts: bool = False,
) -> dict[str, Any]:
    repo = repo.resolve()
    config = load_pack(repo)
    policy = _review_gate_policy(config)
    stage_policies = _ordered_stage_policies(policy)

    satisfied: list[str] = []
    missing: list[str] = []
    reasons: list[str] = []
    blocked_actions = set(FINAL_AUTHORITY_BLOCKS)

    pr = evidence.get("pr")
    if _positive_int(pr):
        satisfied.append(f"pr: {pr}")
    else:
        missing.append("pr")
        pr = 0

    linked_issue = evidence.get("linked_issue")
    if linked_issue is None:
        linked_issue = None
    elif _positive_int(linked_issue):
        satisfied.append(f"linked_issue: GH-{linked_issue}")
    else:
        reasons.append("linked_issue must be a positive integer when present")
        linked_issue = None

    if _non_empty_string(evidence.get("head_sha")):
        satisfied.append(f"head_sha: {evidence['head_sha']}")
    else:
        missing.append("head_sha")

    conditions, condition_missing, condition_reasons = _conditions(evidence)
    missing.extend(condition_missing)
    reasons.extend(condition_reasons)

    stages = evidence.get("stages")
    stage_order: list[str] = []
    for stage_name, stage_policy in stage_policies:
        stage_order.append(stage_name)
        required, required_missing = _stage_required(stage_name, stage_policy, conditions)
        missing.extend(required_missing)
        if required_missing:
            continue
        if required:
            satisfied.append(f"{stage_name} required by conditions")
        stage_satisfied, stage_missing, stage_reasons, stage_blocks = _stage_items(
            repo,
            config,
            stages,
            stage_name,
            stage_policy,
            required,
            pr,
            linked_issue,
            allow_fixture_artifacts=allow_fixture_artifacts,
        )
        satisfied.extend(stage_satisfied)
        missing.extend(stage_missing)
        reasons.extend(stage_reasons)
        if stage_missing or stage_reasons:
            blocked_actions.update(stage_blocks)

    decision = "blocked" if missing or reasons else "allowed"
    return {
        "decision": decision,
        "pr": evidence.get("pr"),
        "linked_issue": evidence.get("linked_issue"),
        "head_sha": evidence.get("head_sha"),
        "stage_order": stage_order,
        "advisory_only": True,
        "reasons": sorted(set(reasons)),
        "satisfied": sorted(set(satisfied)),
        "missing": sorted(set(missing)),
        "blocked_actions": sorted(blocked_actions),
        "verification_commands": [
            "python3 checks/review_gate.py --repo . --evidence <review-gate.json>",
            "python3 checks/check_workflow.py --repo .",
        ],
    }


def print_gate_human(result: dict[str, Any]) -> None:
    print(f"decision: {result['decision']}")
    if result.get("pr"):
        print(f"pr: {result['pr']}")
    if result.get("linked_issue"):
        print(f"linked_issue: GH-{result['linked_issue']}")
    if result.get("head_sha"):
        print(f"head_sha: {result['head_sha']}")
    print("stage_order: " + " -> ".join(result["stage_order"]))
    print("advisory_only: true")
    if result["reasons"]:
        print("reasons:")
        for reason in result["reasons"]:
            print(f"- {reason}")
    if result["missing"]:
        print("missing:")
        for item in result["missing"]:
            print(f"- {item}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Pilot review-gate evidence.")
    parser.add_argument("--repo", default=".", help="Workflow pack root")
    parser.add_argument("--evidence", required=True, help="Review gate evidence JSON file")
    parser.add_argument(
        "--allow-fixture-artifacts",
        action="store_true",
        help="Allow evidence artifacts outside workflow-rendered review/PR paths",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    try:
        evidence = _load_json(Path(args.evidence))
        result = evaluate_review_gate(
            repo,
            evidence,
            allow_fixture_artifacts=args.allow_fixture_artifacts,
        )
    except (SpecRailError, ValueError) as exc:
        result = {
            "decision": "blocked",
            "pr": None,
            "linked_issue": None,
            "head_sha": None,
            "stage_order": [],
            "advisory_only": True,
            "reasons": [str(exc)],
            "satisfied": [],
            "missing": [],
            "blocked_actions": sorted(FINAL_AUTHORITY_BLOCKS),
            "verification_commands": ["python3 checks/review_gate.py --repo . --evidence <review-gate.json>"],
        }

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_gate_human(result)

    return 1 if result["decision"] == "blocked" else 0


if __name__ == "__main__":
    sys.exit(main())
