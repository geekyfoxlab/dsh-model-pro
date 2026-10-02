# Harness 0.2 兼容性

DeepSeek Harness 0.2.0-rc.2 更改了 Typert codec 和设置服务接口。1.1.8 的旧契约在注册时被拒绝，设置页显示“调用失败”；直接调用供应商操作还会遇到 settings.get 不存在或字段不允许写入。

修复同时保留旧版 codec.schema 和 settings.get()/replace() 分支：

- RPC codec 增加 create() 工厂，提供与原 schema 相同的校验。
- 新版从 settings.describe() 读取，使用 mutate() 和 expectedRevision 保存。
- llm-pi-ai 只写 providers。禁用档案、路由、组合、界面偏好和观测快照保存到 dsh-model-pro.state（本插件的 volatile 配置字段）。
- 禁用前先保存备份；供应商写入失败时回滚禁用状态。卸载时保留已缓存状态以恢复供应商，重装后重新应用禁用标记。
- 等本插件配置表单就绪后恢复观测快照和禁用状态，兼容插件的不同加载顺序。

## 常规检查

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Host 冒烟测试覆盖旧版和新版设置接口、供应商增删改、请求头、模型、密钥加密、启停、路由、组合、统计快照、revision 冲突、写入失败回滚及卸载重装。

## 可选的真实运行时检查

tests/runtime.compat.mjs 使用 Harness 自带的 TypertRegistry、SettingsForms、PiConfig 和 Cordis。配置编辑器与凭据服务均为内存替身，不访问真实供应商配置或凭据。此检查需要本机可用的 Harness 运行时，未加入默认 npm test。

tests/runtime.multimodal.mjs 额外验证真实 PiAiAdapter 的图片能力及附件转换、LlmRuntime 的智能路由/组合能力、图片目标筛选。底层推理流使用内存替身，不向外部供应商发送请求。配置测试也覆盖 input 的保存、禁用/启用及卸载恢复。

识别按钮回归使用真实 schema 生成的 `input: []`，验证目录识别及保存、已有设置保留、识别数量、目录失败与恢复、重复识别零写入，以及识别期间的并发模型编辑保护。客户端回归还验证失败提示在当前编辑页可见。

```sh
DSH_RUNTIME_ROOT=/path/to/dsh npm run test:runtime
```

DSH_RUNTIME_ROOT 指向包含 node_modules/@deepseek-ai 的 Harness 运行时目录。Electron ASAR 内的运行时需要使用该应用的 Electron 可执行文件，以 Node 模式执行：

```sh
ELECTRON_RUN_AS_NODE=1 DSH_RUNTIME_ROOT=/path/to/app.asar/dsh \
  /path/to/electron --expose-internals tests/runtime.compat.mjs
ELECTRON_RUN_AS_NODE=1 DSH_RUNTIME_ROOT=/path/to/app.asar/dsh \
  /path/to/electron --expose-internals tests/runtime.multimodal.mjs
```

测试默认在 VM 中加载构建后的 host。可设置 MODEL_PRO_ACTUAL_PLUGIN 为能够解析该 Harness 框架依赖的 dist/host.js 绝对路径，额外验证真实插件 fiber 的启动、卸载和重装。可设置 MODEL_PRO_HOST_BUNDLE 指向旧版 1.1.8 的 host bundle，并配合 EXPECT_INCOMPATIBLE=1 重现缺少 codec.create() 的原始错误。
