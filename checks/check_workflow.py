#!/usr/bin/env python3
"""Validate the harness-pi Pilot workflow contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from review_gate import evaluate_review_gate
from specrail_lib import (
    SpecRailError,
    load_pack,
    read_text,
    validate_action_policy,
    validate_labels,
    validate_state_graph,
    validate_template_parity,
)


REQUIRED_FILES = [
    "AGENTS.md",
    "AGENT_USAGE.md",
    "CLAUDE.md",
    "workflow.yaml",
    "states.yaml",
    "labels.yaml",
    "docs/AGENT_SURFACES.md",
    "docs/AGENT_CODING_RULES.md",
    "docs/REVIEW_RUBRIC.md",
    "checks/specrail_lib.py",
    "checks/route_gate.py",
    "checks/pr_gate.py",
    "checks/review_gate.py",
    "checks/review_json_gate.py",
    "checks/fixtures/review-gate-pass.json",
    "checks/fixtures/review-gate-fail.json",
    "templates/product_spec.md",
    "templates/tech_spec.md",
    "templates/tasks.md",
    "templates/pull_request.md",
    "templates/agent_instructions.md",
    "templates/zh-CN/product_spec.md",
    "templates/zh-CN/tech_spec.md",
    "templates/zh-CN/tasks.md",
    "templates/zh-CN/pull_request.md",
    "templates/zh-CN/agent_instructions.md",
    "skills/harness-pi-workflow/SKILL.md",
    ".github/workflows/workflow-check.yml",
]

REQUIRED_TOKENS = {
    "workflow.yaml": [
        "agent_surfaces:",
        "claude_code:",
        "surface_files_are_adapters: true",
        "default_mode: dry_run",
        "forbidden_agent_actions:",
        "required_human_gates:",
        "review_gate:",
        "/test-review",
        "/code-review",
        "/linus-review",
        "passing_ratings:",
        "action_policy:",
    ],
    "states.yaml": [
        "ready_to_spec",
        "ready_to_implement",
        "agent_review",
        "human_review",
        "merge_ready",
    ],
    "labels.yaml": [
        "readiness:",
        "ready_to_spec",
        "ready_to_implement",
        "security_private",
    ],
    "skills/harness-pi-workflow/SKILL.md": [
        "name: harness-pi-workflow",
        "Route Choice",
        "Review Gate",
        "Coding Discipline",
        "Harness-Pi Architecture Boundaries",
        "Stop Conditions",
    ],
    "AGENTS.md": [
        "docs/AGENT_SURFACES.md",
        "docs/AGENT_CODING_RULES.md",
        "docs/REVIEW_RUBRIC.md",
        "checks/review_gate.py",
    ],
    "CLAUDE.md": [
        "Agent workflow contract",
        "docs/AGENT_SURFACES.md",
        "docs/AGENT_CODING_RULES.md",
        "docs/REVIEW_RUBRIC.md",
        "checks/review_gate.py",
    ],
    "AGENT_USAGE.md": [
        "Agent Surfaces",
        "docs/AGENT_CODING_RULES.md",
        "docs/REVIEW_RUBRIC.md",
        "/test-review",
        "/code-review",
        "/linus-review",
    ],
    "templates/pull_request.md": [
        "## Review Gate",
        "/test-review",
        "/code-review",
        "/linus-review",
    ],
}


def validate_required_files(repo: Path) -> list[str]:
    return [
        f"missing required file: {rel}"
        for rel in REQUIRED_FILES
        if not (repo / rel).is_file()
    ]


def validate_tokens(repo: Path) -> list[str]:
    errors: list[str] = []
    for rel, tokens in REQUIRED_TOKENS.items():
        path = repo / rel
        if not path.is_file():
            continue
        text = read_text(path)
        for token in tokens:
            if token not in text:
                errors.append(f"{rel}: missing token {token!r}")
    return errors


def validate_review_gate_fixtures(repo: Path) -> list[str]:
    errors: list[str] = []
    fixtures = [
        ("checks/fixtures/review-gate-pass.json", "allowed"),
        ("checks/fixtures/review-gate-fail.json", "blocked"),
    ]
    for rel, expected_decision in fixtures:
        path = repo / rel
        if not path.is_file():
            continue
        try:
            evidence = json.loads(read_text(path))
            result = evaluate_review_gate(repo, evidence, allow_fixture_artifacts=True)
        except (json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{rel}: invalid review gate fixture: {exc}")
            continue
        decision = result.get("decision")
        if decision != expected_decision:
            errors.append(
                f"{rel}: expected review gate decision {expected_decision}, got {decision}"
            )
    return errors


def validate_skill_frontmatter(repo: Path) -> list[str]:
    path = repo / "skills/harness-pi-workflow/SKILL.md"
    text = read_text(path)
    if not text.startswith("---\n"):
        return [f"{path}: missing YAML frontmatter"]
    end = text.find("\n---\n", 4)
    if end < 0:
        return [f"{path}: malformed YAML frontmatter"]
    frontmatter = text[4:end]
    errors: list[str] = []
    if "name: harness-pi-workflow" not in frontmatter:
        errors.append(f"{path}: frontmatter name must be harness-pi-workflow")
    if "description:" not in frontmatter:
        errors.append(f"{path}: frontmatter description is required")
    return errors


def discover_spec_dirs(repo: Path) -> list[Path]:
    specs_dir = repo / "specs"
    if not specs_dir.is_dir():
        return []
    dirs = [
        path
        for path in specs_dir.iterdir()
        if path.is_dir() and re.fullmatch(r"GH[0-9]+", path.name)
    ]
    return sorted(dirs, key=lambda path: int(path.name.removeprefix("GH")))


def validate_spec_packet(spec_dir: Path) -> list[str]:
    errors: list[str] = []
    issue_number = spec_dir.name.removeprefix("GH")
    issue_tokens = [f"GH-{issue_number}", f"GH{issue_number}", f"#{issue_number}"]

    for name in ["product.md", "tech.md"]:
        path = spec_dir / name
        if not path.is_file():
            errors.append(f"{spec_dir}: missing {name}")
            continue
        text = read_text(path)
        if not text.strip():
            errors.append(f"{path}: must not be empty")
        if not any(token in text for token in issue_tokens):
            errors.append(f"{path}: missing linked issue token {' or '.join(issue_tokens)}")

    task_path = spec_dir / "tasks.md"
    if not task_path.is_file():
        errors.append(f"{spec_dir}: missing tasks.md")
    else:
        errors.extend(validate_task_plan(task_path, issue_number))
    return errors


def validate_task_plan(path: Path, issue_number: str) -> list[str]:
    errors: list[str] = []
    text = read_text(path)
    if not text.strip():
        return [f"{path}: must not be empty"]

    prefix = f"SP{issue_number}-T"
    seen: set[str] = set()
    for line_number, line in enumerate(text.splitlines(), start=1):
        if "- [" not in line:
            continue
        match = re.search(r"`([^`]+)`", line)
        if not match:
            errors.append(f"{path}:{line_number}: task is missing stable ID")
            continue
        task_id = match.group(1)
        if task_id in seen:
            errors.append(f"{path}: duplicate task ID {task_id}")
        seen.add(task_id)
        if not task_id.startswith(prefix):
            errors.append(f"{path}:{line_number}: task ID {task_id} must start with {prefix}")
        for token in ["Owner:", "Done when:", "Verify:"]:
            if token not in line:
                errors.append(f"{path}:{line_number}: task {task_id} missing {token}")

    if not seen:
        errors.append(f"{path}: no task checklist items found")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate harness-pi Pilot workflow files.")
    parser.add_argument("--repo", default=".", help="Repository root")
    parser.add_argument(
        "--all-specs",
        action="store_true",
        help="Validate every specs/GH<number> directory",
    )
    parser.add_argument(
        "--spec-dir",
        action="append",
        default=[],
        help="Specific spec packet directory to validate",
    )
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    errors: list[str] = []
    try:
        config = load_pack(repo)
        errors.extend(validate_required_files(repo))
        errors.extend(validate_tokens(repo))
        errors.extend(validate_state_graph(config))
        errors.extend(validate_labels(config))
        errors.extend(validate_action_policy(config))
        errors.extend(validate_template_parity(repo))
        errors.extend(validate_review_gate_fixtures(repo))
        errors.extend(validate_skill_frontmatter(repo))

        spec_dirs = [repo / raw for raw in args.spec_dir]
        if args.all_specs:
            spec_dirs.extend(discover_spec_dirs(repo))
        for spec_dir in sorted(set(spec_dirs)):
            errors.extend(validate_spec_packet(spec_dir))
    except SpecRailError as exc:
        errors.append(str(exc))

    if errors:
        print("Pilot workflow check failed")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Pilot workflow check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
