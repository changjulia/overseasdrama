# QS-DRAMA-LYCAN-DW-EP01-10 Detail v2 独立回归

继续使用冻结 Golden v1 SHA `4f36c1df4593442974ac25ee9a3cec64ac10cff537894035eee1633389c96872`。Detail v2 analysis_id 为 `00c90a48-adea-481f-a16f-647411ed373d`，系统快照 SHA 为 `ba9e7cfb25ab1bcf2e3f7a48358d93e83ff84a033ca7f1c711b91b2073bce7ac`。

## 结论

| 层面 | v2 结论 |
|---|---|
| 工程 | **PASS**：真实 Detail v2 已由 qwen-vl-max 回写并 succeeded |
| EP2 安全降级 | **大部修复**：plot/正式人物/关系安全；仍有不安全 precision candidate |
| EP3 关系 | **修复**：Elena–Cora 母女关系不再发布 |
| EP9 事实/因果 | **未修复**：Tiffany 信任结论仍错，且混入 EP10 证据 |
| 高光 | **改善但失败**：16 条有 event/context/production 区间，Golden Top3 仅 1/3 覆盖，0 条可直接制作 |
| 总体 | **NO-GO**：范围归一 60/100（v1 为 48） |

## EP2 无音轨

修复通过的部分：

- episodePlot 明确 `无音轨`、unverified、reviewRequired；
- coreFacts=[]；
- 不再发布人物关系、预言、意图、情绪或因果；
- EP2 没有进入正式 characters，5 个实体均留在 unverified characterCandidates。

仍未通过的部分：0–12s 候选被标 `precisionEligible=true`，把 0s 抱婴女子称作 Amelia，并从 12s 单帧写出“威慑姿态”。Golden 中 Amelia 名卡出现在约 80s，0s 女子身份不能据此回填。该候选 action/dialogue/semantic/shot gate 全部 unverified，且源片无音轨，只能作为待分析候选，不能被理解为精确可制作候选。

## EP3 与 EP9

EP3 先前的母女错误已关闭：published relationships=[]，Elena–Cora 仅为 unverified relationshipCandidate，描述也改为主仆/情感候选。

EP9 仍有两个 P0：

1. `relationshipChange` 继续声称“Alpha 对 Tiffany 的信任动摇”，但原句 `No. Not Tiffany.` 是明确排除 Tiffany。
2. EP9 coreFacts 引用了两条 EP10 证据：0–3.94s Ironfork 推测、13.38–18.62s 召集战士；EP9 result/carryOut 因而被下一集事实污染。跨集连续性应建 typed carry edge，不能篡改事实所属集。

## 人物/关系降级

- characterCandidates=5，全部 unverified/reviewRequired；
- relationshipCandidates=6，全部 unverified/reviewRequired；
- published relationships=0。

这是安全进步。但 24 个 published characters 仍全部 verified，跨集/泛角色消歧未完成。例如 Alpha 标 EP1/EP9 却只有 EP1 evidence；Arya/Orph/Rogue/girl 等可能连续身份仍碎片化。

## 16 条 Precision Candidates

16 条现在都有 narrativeInterval 与 productionInterval，且都 `precisionEligible=true`、`reviewRequired=true`。但：

- 16/16 productionGate 的 action/dialogue/semantic/shot/status 全部 unverified；
- 16/16 没有可消费的 verified safeStart/safeEnd；
- 当前 production-usable 数量仍为 0。

这里必须区分“可进入精细分析队列”和“已经具备精确生产边界”。若 `precisionEligible` 仅表示前者，UI/API 必须显式命名；若表示后者，则当前 16 条全部错误放行。

## Golden Top3

| Golden | v2 覆盖 | 结论 |
|---|---|---|
| EP4 27–54s 蛇形生物→光狼→接婴儿 | 无候选 | 漏检 |
| EP7 41.7–57.2s 鞭击攻防 | narrative 31.04–64.32，production 34.08–62.22 | 时间覆盖成功，边界 gate 未验证 |
| EP8 75.5–80.784s 月石裂纹增强 | narrative 仅到 77.62，production 到 62.71 | 事件未完整覆盖 |

时间覆盖率 1/3；直接制作可用率 0/3。均未达到 ≥90% 门槛。

## 开发项

1. **P0 EP9 结论重算/否定校验**：删除被拒事实后必须重算 relationshipChange；`No. Not Tiffany.` 不得导出怀疑。
2. **P0 Episode-scoped graph**：EP9 coreFacts 只能引用 EP9 evidence；EP10 信息使用 carryOut/carryIn 边。
3. **P0 Precision 语义分层**：区分 analysis-eligible 与 production-eligible；全 gate unverified 时不可对外表达为生产精确可用。
4. **P0 Top3 召回**：补 EP4 27–54、EP8 75.5–结尾事件；保留 EP7 改善并补边界验证。
5. **P1 人物消歧**：跨集 membership 必须逐集有证据；泛角色/别名保持候选，不得全 verified。

准确表述：**Detail v2 工程完成，EP2/EP3 安全性显著改善；内容事实、跨集证据隔离和高光生产边界仍未过门。**
