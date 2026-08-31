# Episode-splice queue E2E

This suite proves the technical episode-splice delivery chain against an
isolated PocketBase instance and the real Python queue worker. It creates three
synthetic 101-second episodes, an approved/verified episode highlight, saves a
canonical project, queues a render, lets `processor.job_worker` claim and
process it, and exercises review and export.

The suite never opens `pb_data`, never binds port 8090, and writes PocketBase
data, storage, public output, and worker output below a temporary directory.
Synthetic colour/audio sources prove media plumbing and gates only; they do not
replace acceptance with licensed business footage.

Run from the repository root:

```bash
python3 -m unittest -v tests.e2e_episode_splice.test_episode_splice_queue_e2e
```
