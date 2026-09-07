"""Offline Qwen text tokenizer; newline JSON protocol, never contacts a model."""
import json,sys
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tmp/narration-mvp-deps'))
from tokenizers import Tokenizer
tokenizer=Tokenizer.from_file(str(root/'.codex-runtime/narration-intake/qwen-tokenizer.json'))
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'id':request['id'],'tokens':[len(tokenizer.encode(text,add_special_tokens=False).ids) for text in request['texts']]}),flush=True)
