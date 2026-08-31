# 失败注入验收证据

- 生成时间（UTC）：`2026-08-30T13:01:25.900676+00:00`
- 离线执行：是
- 生产变更：无
- 结论：**通过**

| 场景 | 结果 |
|---|---|
| `test_corrupt_media_is_rejected (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_corrupt_media_is_rejected)` | ok |
| `test_failed_qc_never_publishes_staged_or_partial_output (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_failed_qc_never_publishes_staged_or_partial_output)` | ok |
| `test_missing_or_http_failed_source_is_not_silently_accepted (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_missing_or_http_failed_source_is_not_silently_accepted)` | ok |
| `test_qc_rejects_duration_drift_and_codec_mismatch (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_qc_rejects_duration_drift_and_codec_mismatch)` | ok |
| `test_transient_failure_retries_but_permanent_media_failure_does_not (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_transient_failure_retries_but_permanent_media_failure_does_not)` | ok |
| `test_video_without_audio_is_rejected_by_qc (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_video_without_audio_is_rejected_by_qc)` | ok |

## 覆盖范围

源文件 404、坏媒体、无音轨、QC 时长漂移与编码不符、worker transient/permanent 重试分类，以及 QC 失败时临时文件不发布。

## 原始输出

```text
test_corrupt_media_is_rejected (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_corrupt_media_is_rejected) ... ok
test_failed_qc_never_publishes_staged_or_partial_output (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_failed_qc_never_publishes_staged_or_partial_output) ... 127.0.0.1 - - [30/Aug/2026 21:01:25] "GET /api/files/episodes/ep1/episode.mp4 HTTP/1.1" 200 -
ok
test_missing_or_http_failed_source_is_not_silently_accepted (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_missing_or_http_failed_source_is_not_silently_accepted) ... 127.0.0.1 - - [30/Aug/2026 21:01:25] code 404, message File not found
127.0.0.1 - - [30/Aug/2026 21:01:25] "GET /absent.mp4 HTTP/1.1" 404 -
ok
test_qc_rejects_duration_drift_and_codec_mismatch (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_qc_rejects_duration_drift_and_codec_mismatch) ... ok
test_transient_failure_retries_but_permanent_media_failure_does_not (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_transient_failure_retries_but_permanent_media_failure_does_not) ... ok
test_video_without_audio_is_rejected_by_qc (tests.failure_injection.test_release_failure_injection.ReleaseFailureInjection.test_video_without_audio_is_rejected_by_qc) ... ok

----------------------------------------------------------------------
Ran 6 tests in 0.907s

OK
```
