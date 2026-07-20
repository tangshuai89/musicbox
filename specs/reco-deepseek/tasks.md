- [x] 1. packages/server/src/reco/reco.service.ts: DeepSeek fetch 包装 + JSON 解析 retry + 429/5xx 分类
- [x] 2. RecoService: 拿 library → 拼 prompt → 调 DeepSeek → 解析 → 用 P0 统一搜索 fill 平台源
- [x] 3. Controller: GET /reco/status, POST /reco/run, POST /reco/key
- [x] 4. reco/reco.module.ts 注册并 import 到 app.module.ts
- [x] 5. key 持久化: .storage/secrets.json (走 StorageService，git-ignored)
- [x] 6. 前端 api.ts: fetchRecoStatus / runReco / saveRecoKey
- [x] 7. RecoKeyModal: 内联组件，key 输入 + 保存（不抽独立文件）
- [x] 8. 主界面加 "🎲 推荐" 按钮 + 未配 key 红点提示
- [x] 9. 白盒测试 12 条：响应解析（4 种形态）/ 推荐去重（库内 + 内部）/ prompt 拼装 / key 校验
- [x] 10. typecheck + 全量测试（search 12 + match 8 + reco 12 = 32 条）全绿
- [x] 11. e2e smoke: 5 个 case（status / no key 412 / 短 key 400 / set key 200 / no lib 400）
- [x] 12. auto-continue：播到最后一首自动取下一批续播（不循环回第一首）——
      queueRef.loadMore + useReco loadMore；服务端 exclude 去重（reco.test #13）
- [x] 13. 推荐质量调优 v1.1（#1~#7）：填源匹配校验 + 并行补位 + 库随机采样 +
      超额要 + session 历史去重 + prompt 强化 + 统一 normalizeKey（reco.test #14~16）
