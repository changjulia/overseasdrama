"""Evaluate a JSON gold fixture and optionally apply the production gate."""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from processor.calibration import evaluate, production_gate

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()
    metrics = evaluate(json.loads(args.fixture.read_text(encoding="utf-8")))
    print(json.dumps({"metrics": metrics, "gate": production_gate(metrics)}, indent=2, sort_keys=True))
    return 0 if production_gate(metrics)["passed"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
