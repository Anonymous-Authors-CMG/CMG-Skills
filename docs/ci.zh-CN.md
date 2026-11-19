# PR / MR 机器人

方法和 skill 一样，只是不在你自己电脑上跑，而是在每个 pull request 上自动跑。

PR 打开后，机器人读取它的 diff，用和 skill 相同的两阶段方法在仓库的 open issue 里检索，然后发**一条评论**，里面有两样东西：

- 这个 PR 看起来是在处理哪个 open issue，并附上依据。作者可以在合并前补上 `Fixes #n`。
- 一份写清楚了「为什么改」的 squash 提交信息，合并时直接粘进去就行。

它不会改 PR、不加标签、不关闭任何东西。再次运行时会更新原来那条评论，不会新增评论。

## 为什么放在 CI 里

- **等多久都无所谓。** 一次完整检索要 30 到 60 秒。在终端里等这么久很烦，在 CI 里没人盯着。
- **squash 合并会把「为什么」丢掉。** 很多项目合并时直接用 PR 标题当提交信息，机器人能给一份更好的。
- **关联经常被漏掉。** 维护者常常遇到这种情况：一个 PR 其实修了某个 issue，但没人关联，那个 issue 就一直开着。机器人会把它指出来。

## 评论长什么样

下面是在 [keras-team/keras#24152](https://github.com/keras-team/keras/pull/24152) 上的一次真实运行。我把这个 PR 自带的 `Fixes` 那一行对机器人隐藏了，让它自己从 153 个 open issue 里找：

> ### Issue Commit
>
> This PR looks like it addresses **[#24080](https://github.com/keras-team/keras/issues/24080)
> `keras.ops.roll` rejects tensor `shift`/`axis` on the TensorFlow backend**
>
> > Strong match · The issue reports that `ops.roll` on the TensorFlow backend
> > raises ValueError when `shift` or `axis` is a tensor and `axis` is given,
> > because `to_tuple_or_list` rejects tensors. The PR changes that same `roll`
> > function [...] and adds tests for the issue's exact repro.
>
> If that's right, add `Fixes #24080` to the description so the issue closes on merge.
>
> <details open><summary><b>Suggested squash commit message</b></summary>
>
> ```text
> fix: accept tensor shift/axis in ops.roll on TensorFlow backend
>
> On the TensorFlow backend, keras.ops.roll raised a ValueError whenever
> `axis` was given and `shift` or `axis` was a tf.Tensor [...]
>
> Fixes #24080
> ```
> </details>

找到的 issue 是对的，用时 43 秒。

## 没有匹配时会直说

检索这一步一定会返回*某个* issue，即使 PR 和所有 issue 都无关。所以机器人会拿排名靠前的结果再和 diff 核对一遍：说不出具体对应的是哪个函数、哪个报错或哪个行为的，就丢掉。

| PR | 正确的 issue | 机器人的结论 |
|---|---|---|
| [keras#24152](https://github.com/keras-team/keras/pull/24152) | #24080 | #24080，强匹配 |
| [keras#24251](https://github.com/keras-team/keras/pull/24251) | #24248 | #24248，强匹配 |
| [keras#24228](https://github.com/keras-team/keras/pull/24228)（改 CI 配置，没有对应 issue） | 无 | "No open issue clearly matches" |
| [gitlab-org/cli!4485](https://gitlab.com/gitlab-org/cli/-/merge_requests/4485) | #7865 | #7865，强匹配 |
| [gitlab-org/cli!4486](https://gitlab.com/gitlab-org/cli/-/merge_requests/4486) | #7887 | #7887，强匹配 |

5 个 PR 只能算冒烟测试，不能当评测结果。论文里的数据（Hit@1 0.890）来自 1,200 个样本。

如果 PR 描述里已经写了 `Fixes #n` 或 `Closes #n`，机器人会跳过检索，直接根据那个 issue 写提交信息。

---

## GitHub Actions

**1.** 添加仓库 Secret（Settings → Secrets and variables → Actions）：

| Secret | 示例 |
|---|---|
| `CMG_API_KEY` | 你的 API key |
| `CMG_MODEL` | `gpt-4.1-mini`、`deepseek-chat` 等 |
| `CMG_BASE_URL` | 不用 OpenAI 时才需要，例如 `https://api.deepseek.com` |

**2.** 新建 `.github/workflows/issue-commit.yml`（[从这里复制](../examples/github/issue-commit.yml)）：

```yaml
name: Issue Commit
on:
  pull_request:
    types: [opened, ready_for_review, reopened]

permissions:
  contents: read
  issues: read
  pull-requests: write

jobs:
  suggest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: Anonymous-Authors-CMG/CMG-Skills@v1
        with:
          api-key: ${{ secrets.CMG_API_KEY }}
          base-url: ${{ secrets.CMG_BASE_URL || 'https://api.openai.com/v1' }}
          model: ${{ secrets.CMG_MODEL }}
```

不需要 checkout 步骤，机器人通过 API 读取所需的一切。

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `api-key` | *必填* | OpenAI 兼容接口的 key |
| `model` | *必填* | 模型名 |
| `base-url` | `https://api.openai.com/v1` | 接口地址 |
| `github-token` | `github.token` | 需要 `pull-requests: write`、`issues: read` 权限 |
| `pool-size` | `200` | 参与检索的 open issue 数量，从新到旧取 |
| `min-confidence` | `medium` | `low` / `medium` / `high`，置信度低于这个值就不推荐 |
| `include-drafts` | `false` | 草稿 PR 也运行 |
| `dry-run` | `false` | 只写入 job summary，不发评论 |
| `fail-on-error` | `false` | 默认出错只给警告，不会让 PR 检查失败 |
| `pr-number` | | 用于 `workflow_dispatch` 等非 PR 事件 |

### 输出

`status`（`ok` / `skipped` / `error`）、`issue`、`verdict`（`fixes` / `partial` / `linked`）、`confidence`、`message`。例如，找到可能对应的 issue 时自动加标签：

```yaml
      - id: cmg
        uses: Anonymous-Authors-CMG/CMG-Skills@v1
        with: { api-key: ..., model: ... }
      - if: steps.cmg.outputs.issue != '' && steps.cmg.outputs.verdict == 'fixes'
        run: gh pr edit ${{ github.event.pull_request.number }} --add-label has-issue
        env: { GH_TOKEN: ${{ github.token }} }
```

### 来自 fork 的 PR

用 `pull_request` 触发时，来自 fork 的 PR 拿到的是只读 token，也拿不到 Secret，所以机器人跑不起来。常用的解决办法是改用 `pull_request_target`，它在目标仓库的上下文中运行。

在这里用它是安全的：这个 action 从不 checkout、也从不运行 PR 里的代码，只是通过 API 读取 diff。**注意不要在这个 workflow 里加对 PR head 的 `actions/checkout`。**

```yaml
on:
  pull_request_target:
    types: [opened, ready_for_review, reopened]
```

---

## GitLab CI

**1.** 创建项目访问令牌：Settings → Access tokens，角色选 **Reporter**，权限范围选 **api**。

**2.** 添加 CI/CD 变量（Settings → CI/CD → Variables，勾选 *Mask*）：

| 变量 | 示例 |
|---|---|
| `CM_API_KEY` | 你的 API key |
| `CM_LLM_MODEL` | `gpt-4.1-mini`、`deepseek-chat` 等 |
| `CM_BASE_URL` | 不用 OpenAI 时才需要 |
| `GITLAB_TOKEN` | 上一步创建的项目访问令牌 |

如果变量勾选了 *Protected*，它们只会传给受保护分支上的流水线，从普通功能分支发起的 MR 流水线拿不到。要么不勾 *Protected*，要么把源分支设为受保护。

**3.** 在 `.gitlab-ci.yml` 里引入模板：

```yaml
include:
  - remote: https://raw.githubusercontent.com/Anonymous-Authors-CMG/CMG-Skills/v1/ci/gitlab-ci.yml
```

这会在 `test` 阶段加一个名为 `issue-commit` 的任务。它只在 MR 流水线上运行，设置了 `allow_failure: true`，结果会作为产物保存在 `cmg/` 目录里。需要调整的话，在你自己的文件里覆盖即可：

```yaml
issue-commit:
  stage: review
  variables:
    CMG_POOL_SIZE: "400"
    CMG_MIN_CONFIDENCE: high
```

自建 GitLab 的用法完全一样，API 地址会自动从 `CI_API_V4_URL` 读取。如果你的 runner 访问不了 github.com，就在内网镜像一份这个仓库，并把 `CMG_REPO` 设成镜像的 clone 地址。

---

## 不装也能先试

可以对任意公开的 PR 或 MR 运行，把评论打印出来，而不是真的发出去：

```bash
export CM_API_KEY=... CM_BASE_URL=... CM_LLM_MODEL=...
export GITHUB_TOKEN=...          # 可选，避免每小时 60 次的限额

python3 skills/commit-message-from-issue/scripts/ci_review.py \
  --pr-url https://github.com/keras-team/keras/pull/24152 \
  --ignore-existing-links --dry-run
```

`--ignore-existing-links` 会把 PR 自带的 `Fixes #n` 对机器人隐藏，上面那张表就是这样测出来的。这里也可以用任何 agent CLI，比如 `CM_LLM_CMD=claude`。

## 成本

每个 PR 大约调用模型 6 到 9 次，分别是：

- `ceil(issue 总数 / 40)` 次只看标题的短调用
- 1 次合并
- 1 次对 5 个 issue 正文的重排
- 1 到 2 次核对
- 1 次生成提交信息

issue 池为 200 个时，总输入大约 6 万到 10 万 token。用 `gpt-4.1-mini` 或 `deepseek-chat` 的话，每个 PR 大约 1 美分。

默认触发条件（`opened`、`ready_for_review`、`reopened`）下，每个 PR 只跑一次。如果加上 `synchronize`，每次 push 都会重跑，提交信息能保持最新，但成本更高。

## 哪些数据发到哪里

- **发给你的模型接口：** PR 标题、描述（前 1,500 个字符）、diff（去掉 lock 文件和压缩文件，最多 12,000 个字符）、所有 open issue 的标题，以及最多 5 个 issue 的正文。
- **GitHub 或 GitLab：** 读取 PR 和 issue，写一条评论。

没有别的了。diff 是通过 API 读取的，PR 里的代码从不会被 checkout 或运行。
