# 在 SWE-bench 上评测 harness-pi（claw-swe-bench 集成指南）

> 面向第一次接触的人。照着走，你能：① 让 harness-pi 在一个真实 SWE-bench issue 上跑出补丁并用官方评估器判 resolved；② 看懂整条管线怎么搭的，自己扩展到更多实例 / 其它模型 / 全 Lite-80。
>
> 关联：harness-pi GitHub issue **#85**（任务与验收标准）；本指南是它的落地记录 + 复现手册。

---

## 0. 这是什么、为什么这么做

**目标**：客观验证 harness-pi 这个 agent **harness** 的真实编码能力——能不能自主解决真实 GitHub issue。

**为什么用 SWE-bench / claw-swe-bench**：harness-pi 是个 harness（“claw”）。一个关键事实——*同一个模型换不同 harness，SWE-bench 分数常差 10–20 个百分点*——所以验证 harness 价值的正道是：**固定模型 + 固定预算，比 harness-pi 的解决率 vs 其它 harness**。[`claw-swe-bench`](https://github.com/opensquilla/claw-swe-bench)（arXiv 2606.12344）正是为此设计的：统一 prompt / 预算 / workspace 契约 / 补丁提取 / 评估器，让 harness 成为受控变量。

**整体数据流**：
```
run_infer.py ──► orchestrator ──► SWEBenchWorkspace(Docker容器) ── claw-agnostic（不分 harness）
                     │                     │
                     └──► HarnessPiAdapter hooks ────────────────── harness-pi 专属
                          (claw_swebench/claws/harnesspi.py)
run_eval.py / swebench.harness.run_evaluation ──► 官方 SWE-bench 评估（隐藏测试，判 resolved）
```
- claw-agnostic core 负责：加载数据集、起容器、准备 /testbed、剥离 future commit、渲染统一 prompt、用 `git diff` 收补丁、写 predictions、调评估器。
- **adapter 只负责 harness 专属的事**：怎么把 harness-pi 运行时塞进容器、怎么发任务。

---

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| Docker | 跑 SWE-bench 容器。Apple Silicon 也行（走 x86_64 emulation，见 §6 坑） |
| `uv` | 建隔离 python 环境（claw core + swebench 各一个） |
| harness-pi 已 build | `apps/coding-agent/dist/cli.js` 存在（`pnpm -r build`） |
| 一个模型 API key | 容器内 hpi 调它。本指南用 `dashscope:qwen-plus`（key 在 macOS keychain，名 `DASHSCOPE_API_KEY`） |
| 磁盘 | 每个 SWE-bench 实例镜像 ~3–4GB |

---

## 2. 一次性环境搭建

### 2.1 拿到 claw-swe-bench + harnesspi adapter

```bash
git clone https://github.com/opensquilla/claw-swe-bench ~/Dev/claw-swe-bench
cd ~/Dev/claw-swe-bench
git checkout harnesspi-adapter   # 含 harnesspi adapter 的分支（本仓提供，见 §5）
```
adapter 三处改动：`claw_swebench/claws/harnesspi.py`（新增）、`claw_swebench/claws/__init__.py`（注册 `harnesspi`）、`claw_swebench/config.py`（`CLAW_DEFAULTS["harnesspi"]` + `HARNESSPI_NODE_DIR`/`HARNESSPI_REPO_DIR`）。

### 2.2 抽一个 Linux(amd64) node（关键！别用宿主 node）

SWE-bench 容器是 Linux x86_64，宿主（尤其 macOS）的 node **不能**挂进去。从 node 镜像抽一个 amd64 linux node：
```bash
NODEDIR=~/.cache/harnesspi-linux-node; mkdir -p "$NODEDIR/bin"
cid=$(docker create --platform linux/amd64 node:22-bullseye)   # bullseye 基底 glibc 兼容更广
docker cp "$cid:/usr/local/bin/node" "$NODEDIR/bin/node"; docker rm "$cid"
file "$NODEDIR/bin/node"   # 应为 ELF x86-64
```
> 为什么 bullseye：node 二进制依赖宿主基底的 glibc/libstdc++。bullseye(glibc2.31) 抽的 node 能在 bullseye 和 bookworm 的 SWE-bench 镜像里都跑；bookworm(2.36) 抽的则在更老镜像里挂。

### 2.3 两个 python 环境

```bash
# claw core（run_infer 用）
cd ~/Dev/claw-swe-bench
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python datasets pyyaml

# swebench 官方评估器（独立 venv）
uv venv ~/.cache/swe-bench-env --python 3.12
uv pip install --python ~/.cache/swe-bench-env/bin/python swebench   # 本记录用 4.1.0
```

### 2.4 验证 adapter 注册成功

```bash
.venv/bin/python -c "from claw_swebench.claws import CLAWS, get_adapter; print(sorted(CLAWS)); print(get_adapter('harnesspi').name)"
# 期望: [...'harnesspi'...]  /  harnesspi
```

---

## 3. 拿一个实例镜像

claw 期望本地镜像名 `sweb.eval.x86_64.<instance_id>:latest`。dockerhub 上的预构建名是 `swebench/sweb.eval.x86_64.<id 把 __ 换成 _1776_ 并小写>`。拉下来 retag 成两种名（infer 用 `__` 名、官方 eval 用 `_1776_` 名）：

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
inst=sphinx-doc__sphinx-8721
t=$(echo "$inst" | sed 's/__/_1776_/' | tr 'A-Z' 'a-z')
docker pull --platform linux/amd64 "swebench/sweb.eval.x86_64.$t:latest"
docker tag "swebench/sweb.eval.x86_64.$t:latest" "sweb.eval.x86_64.$inst:latest"
docker tag "swebench/sweb.eval.x86_64.$t:latest" "sweb.eval.x86_64.$t:latest"
```
> 先用 `docker manifest inspect swebench/sweb.eval.x86_64.$t:latest` 确认存在（快，不下载）。

---

## 4. 跑：推理 → 评估

### 4.1 推理（run_infer）— harness-pi 在容器里改代码、收补丁

```bash
cd ~/Dev/claw-swe-bench
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export DASHSCOPE_API_KEY=$(security find-generic-password -a "$USER" -s DASHSCOPE_API_KEY -w)
.venv/bin/python run_infer.py \
  --claw harnesspi --dataset verified \
  --instance_ids sphinx-doc__sphinx-8721 \
  --run_id myrun --timeout 1200
```
产物在 `artifacts/myrun/`：`predictions.jsonl`（model_patch）、每实例 `prompt.txt / agent_stdout.log / agent_stderr.log / metadata.json / git.patch`。
- 多实例：`--instance_ids a b c ...` 或 `--instance_file config/verified_mini_50.txt`。
- 并发：`--workers N`（emulation 下推理阶段是模型延迟主导，2 个并发没问题）。

### 4.2 评估（官方 swebench）— 判 resolved

**别用 claw 自带的 `run_eval.py`**（它写死 `--namespace ""`，会在本地从零 build 镜像，emulation 下 apt build 必挂）。**直接调 swebench 用 `--namespace swebench` 拉预构建镜像**：
```bash
cd ~/Dev/claw-swe-bench/.eval-work 2>/dev/null || mkdir -p ~/Dev/claw-swe-bench/.eval-work && cd "$_"
DOCKER_DEFAULT_PLATFORM=linux/amd64 ~/.cache/swe-bench-env/bin/python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path ~/Dev/claw-swe-bench/artifacts/myrun/predictions.jsonl \
  --max_workers 1 --run_id myrun \
  --instance_ids sphinx-doc__sphinx-8721 \
  --namespace swebench
```
看到 `Found N existing instance images. Will reuse them.` 就对了（不 build）。报告写到 cwd 的 `<model>.<run_id>.json`：`resolved_instances / resolved_ids / empty_patch_instances / error_instances`。

---

## 5. harnesspi adapter 怎么写的（开发者扩展用）

模板是 openclaw（同为 Node CLI）。核心就两个 hook：

```python
class HarnessPiAdapter(BaseClawAdapter):
    name = "harnesspi"

    def container_run_args(self, instance_id):           # docker run 的额外参数
        args = ["-v", f"{HARNESSPI_NODE_DIR}:/opt/hpi-node:ro",   # 挂 linux node
                "-v", f"{HARNESSPI_REPO_DIR}:/opt/harness-pi:ro"] # 挂 harness-pi 整仓(cli+node_modules)
        for var in FORWARD_KEYS:                          # 转发模型 key 进容器
            if os.environ.get(var): args += ["-e", f"{var}={os.environ[var]}"]
        return args

    def send_task(self, prompt, agent_id, container_name, artifact_dir, instance_id):
        cmd = ["docker","exec", container_name,
               "/opt/hpi-node/bin/node", "/opt/harness-pi/apps/coding-agent/dist/cli.js",
               "--cwd","/testbed", "--model", self.model, "--yolo",
               "--log-dir", f"/tmp/hpi-logs/{instance_id}",   # logs 出 /testbed，不污染补丁！
               prompt]                                         # one-shot headless
        # ... subprocess.run(timeout=self.timeout+buffer) → 返回 AgentResult
```
设计要点：
- **无状态**：hpi one-shot 不跨实例持久 → `create_agent/delete_agent` 是 no-op。
- **不污染补丁**：`--log-dir /tmp/...` 让 `.harness-pi/` 不落在 `/testbed`（补丁靠 `git diff /testbed` 收）。
- **污染边界天然满足**：harness-pi 第一方工具是 read/bash/edit/write/grep/find/ls，**无 web/fetch 工具** → agent 拉不到上游修复。公平性靠固定 prompt + future-commit 剥离（core 已做）。
- **限时**：hpi one-shot 没有 turn 上限 flag，靠 subprocess timeout 限（同 openclaw）。

要换模型：`--model anthropic:claude-... / openai:gpt-... / dashscope:qwen-plus`（在 `FORWARD_KEYS` 里加对应 env key 即可）。

---

## 6. 踩坑全集（Apple Silicon 复现的血泪）

| 现象 | 根因 | 解 |
|---|---|---|
| `Unknown option: --max-turns`，agent 0.9s 秒退、空补丁 | hpi **one-shot 没有 `--max-turns` cli flag**（那是 `/goal` 命令内部参数） | adapter 别传该 flag，靠 timeout 限时 |
| eval 报 `BuildImageError ... sweb.base.py ... apt ... code 100` | claw `run_eval.py` 写死 `--namespace ""` → 本地从零 build base 镜像，emulation 下 apt build 挂 | 直接调 `swebench ... --namespace swebench` 拉预构建镜像（§4.2） |
| node 在容器里跑不起来 / 架构不符 | 抽成了 **arm64** node（Apple Silicon 默认），但 SWE-bench 镜像是 **x86_64** | `docker create --platform linux/amd64 node:22-bullseye` 抽 amd64 node；全程 `export DOCKER_DEFAULT_PLATFORM=linux/amd64` |
| node 加载报 GLIBC/GLIBCXX 版本 | node 二进制基底太新 | 用 `node:22-bullseye`（更老 glibc）抽，兼容更多镜像 |
| 容器里 `node cli.js` 找不到模块 | 只挂了 dist、没挂 node_modules | 挂 **整个 harness-pi 仓**（pnpm 的 symlink/虚拟 store 在仓内，整仓挂才完整）；实测 macOS 装的 node_modules 在 linux node 下纯 JS 跑得通 |
| 评估找不到本地镜像、又去 build | swebench 期望的本地镜像名（`_1776_` 形）与 claw 的（`__` 形）不一致 | retag 成两种名（§3） |
| 补丁里混进 agent 自写的测试文件 | hpi 自主时可能写个临时 test | 无害：官方评估只跑**隐藏的** FAIL_TO_PASS/PASS_TO_PASS，agent 写的测试不影响判定 |

---

## 7. 扩展 / 上规模

- **更多实例**：`config/verified_mini_50.txt`（50 个 python：25 sphinx + 25 django）。`--instance_file` 喂它。
- **Lite-80（论文低成本子集，真数字）**：8 语言 80 实例（multilingual 300 + verified-mini 50 里按论文 cost/rank 选）。实例清单见 claw-swe-bench README 的 *Instance lists*。⚠️ emulation×80 + 80 次真模型调用 = 慢 + 烧钱，先小批 pilot 估算成本再上全集。
- **全 350 集 / 多语言**：`--dataset multilingual`，需对应镜像（同样 dockerhub 拉 + retag）。
- **对标其它 claw**：固定同一模型，分别 `--claw openclaw/hermes/.../harnesspi`，比 resolved-rate——这才是 harness 价值的真实度量。

---

## 8. 怎么诚实读结果

- **1 个实例 resolved ≠ 分数**：单实例可能偏易；要 resolved-rate 必须跑批量（Lite-80）。
- **官方评估抗 reward-hack**：跑的是 agent 看不到的隐藏测试，所以 resolved=true 是真过、不是碰巧/作弊。但榜单层面约 20% 的“solved”被指存在偶过/hack，报数时连 **empty-patch 率 / error 率** 一起报才有意义。
- **报数必带语境**：同一模型 + 同一预算 + harness 名，否则数字不可比（harness 解释大半波动）。
- **emulation 失真**：Apple Silicon 上跑 x86_64 慢、个别测试可能因 timeout 误判；真正报榜应在 x86_64 Linux 上跑。本机结果适合**自检 / 相对对比 / 迭代**，正式数字建议上 x86_64 机器复跑。

---

## 9. 当前进度

- ✅ harnesspi adapter 落地、注册（claw-swe-bench 分支 `harnesspi-adapter`，commit 2d6c94f）。
- ✅ 单实例 smoke：`sphinx-doc__sphinx-8721`（qwen-plus）→ **官方评估 resolved 1/1**。
- ✅ Pilot（6 有效实例，qwen-plus）→ **3/6 resolved（50%）**；连 smoke 跨 7 实例 4/7≈57%。每实例 input token 15万–66万、**零缓存命中**。详见 [`reports/swe-bench-pilot-2026-06-17.md`](../reports/swe-bench-pilot-2026-06-17.md)。
- ⬜ Lite-80 真数字（管线已通，估 ~$10–15 + 数小时；建议上 x86_64 + 固定模型对标其它 claw）。
- 🐛 已知坑：`run_evaluation` 多实例 + HF 加载本机间歇 flake → **逐实例 eval + 本地 jsonl** 绕开（见 reports 末尾）。
