"""Export the dbt marts to static JSON for the docs/ GitHub Pages dashboard.

Run manually whenever you want to refresh the published snapshot:

    pip install -r requirements-dev.txt
    export GCP_PROJECT=your-gcp-project-id
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-service-account.json
    python scripts/export_marts.py
    git add docs/data && git commit -m "Refresh dashboard data" && git push

This is a deliberate v1 choice: no CI credentials, no auto-push - you review what's about to go
public (this repo, and therefore docs/data/*.json, is public once GitHub Pages is on) before it
does. `dbt/models/marts/**/*.sql` is where any column this script relies on gets defined.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "docs" / "data"

MARTS = {
    "commune_opportunity_score": "real_estate",
    "department_opportunity_score": "real_estate",
    "equity_performance_summary": "portfolio",
    "alternatives_performance_summary": "alternatives",
}


def export(project: str, dataset: str) -> None:
    client = bigquery.Client(project=project)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    counts = {}
    for table, _domain in MARTS.items():
        table_id = f"{project}.{dataset}.{table}"
        print(f"Querying {table_id} ...", file=sys.stderr)
        rows = list(client.query(f"select * from `{table_id}`").result())
        records = [dict(row.items()) for row in rows]
        # BigQuery DATE/DATETIME/DECIMAL values aren't natively JSON-serializable.
        records = json.loads(json.dumps(records, default=str))

        out_path = OUTPUT_DIR / f"{table}.json"
        out_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
        counts[table] = len(records)
        print(f"  wrote {len(records)} rows -> {out_path.relative_to(REPO_ROOT)}", file=sys.stderr)

    meta = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "project": project,
        "dataset": dataset,
        "row_counts": counts,
    }
    (OUTPUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"  wrote meta.json", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT"), help="GCP project ID (default: $GCP_PROJECT)")
    parser.add_argument("--dataset", default=os.environ.get("ANALYTICS_DATASET", "analytics"), help="BigQuery dataset the marts live in (default: analytics, matching dbt/profiles.yml)")
    args = parser.parse_args()

    if not args.project:
        parser.error("--project or $GCP_PROJECT is required")

    export(args.project, args.dataset)


if __name__ == "__main__":
    main()
