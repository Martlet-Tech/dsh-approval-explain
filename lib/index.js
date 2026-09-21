/**
 * approval-explain —— 主机半（node 侧）。
 *
 * ## 这个插件解决什么
 *
 * dsh 的审批卡片里有一块「详情」区（`conversation.approval.detail` 插槽）。
 * 它由一个只认 `args.command` 字段的提取器填充：
 *
 *     packages/client/ui-chat/src/client/chat/ApprovalCommand.tsx:20
 *     return typeof args.command === 'string' ? args.command : undefined
 *
 * 于是只有 bash/pwsh 这类参数名恰好叫 `command` 的工具能把内容铺进去；
 * write/edit 这类参数是 `file_path` + `content` 的工具，那一块**永远是空的**。
 * 用户面对一张写着「escalate sandbox to danger-full-access」的卡片时，
 * 看不到自己到底要批准什么。
 *
 * ## 为什么主机半是必需的一半
 *
 * 「解释这段命令」需要一次模型调用。而 dsh 里：
 *
 *   * `ctx.llm` 是**主机侧**服务，且**没有** `@Remote` —— 浏览器够不着它；
 *   * 用 `@Remote` 自建远程端点也走不通：Typert 的代码生成只扫
 *     `<仓库根>/packages/`（`packages/typert/generator/src/analyzer.ts:488`），
 *     仓库外插件拿不到生成产物。
 *
 * 唯一现成、浏览器够得着的主机入口是**人类命令**：`ctx.remote.commands.execute()`
 * 早已挂载，而命令 handler 跑在主机侧 —— 那里可以调用 `ctx.llm`。
 * `/compact` 就是这条链路的既有先例。
 *
 * ## 为什么整个文件没有任何 import
 *
 * 本包作为**树外**插件经 profile 的 junction 装载。Node 解析依赖时从
 * junction 的**真实路径**（本包所在目录）向上查找，而那里没有
 * `@deepseek-ai/*` 的 `node_modules`，所以任何 `import '@deepseek-ai/...'`
 * 都会 `ERR_MODULE_NOT_FOUND`。
 *
 * 因此这里**只用运行时拿得到的服务与结构**：
 *
 *   * `ctx.get('llm')` 取 LLM 服务，不 import 它的模块；
 *   * 消息对象按 `dsh-llm` 的 Message 结构**字面构造**
 *     （`{ id, role, content, source }`；`createMessage` 只做
 *     `structuredClone` + 冻结，没有额外规范化）；
 *   * 文本块累积自己写，不依赖 `BlockAssembler`。
 *
 * 代价是耦合了 `StreamChunk` 的字段名，收益是零依赖 —— 这是树外插件
 * 在这个版本下唯一能跑通的形态。
 *
 * ## 为什么不用 `ctx.approval` 做二次确认
 *
 * `ctx.approval.request()` 要求当前有**打开的 turn**
 * （`packages/interaction/user-approval/src/index.ts:208-216`），而命令 handler
 * 是显式「不包在 turn 里」的日志式执行，在 handler 里调它会直接抛错。
 *
 * @module approval-explain
 */

/** 命令名（不含前导斜杠）。 */
export const EXPLAIN_COMMAND = 'explain'

/** 一次解释请求的输出上限。 */
const MAX_OUTPUT_TOKENS = 700

/** 构建给模型的系统提示词。 */
function systemPrompt() {
  return [
    'You explain one shell command or one file-writing tool call to a non-expert user who is about to approve it in an AI coding agent.',
    '',
    'Answer in the language of the user request (Chinese when it is Chinese). Be concise and concrete.',
    'Use exactly these three lines, each starting with the given marker:',
    '',
    '做什么: <one sentence on the concrete effect>',
    '读写改: <which files, directories, or system state are read, written, modified, or executed; say none when purely read-only>',
    '安全: <risky|注意|安全> — <one sentence of justification; call out deletion, overwrite, privilege escalation, network access, credential access, or irreversible operations>',
    '',
    'Rules:',
    '- Judge the actual command text, not the fact that it was submitted for approval.',
    '- If the input is a file write, describe the target path and what the content does.',
    '- Never claim something is safe when it deletes, overwrites, or escalates.',
    '- Output only those three lines. No preamble, no Markdown fences, no extra sections.',
  ].join('\n')
}

/**
 * 构建送给模型的一段输入文本。
 * @param text - 待解释的命令或内容。
 * @returns 完整的用户消息文本。
 */
function userText(text) {
  return [
    'Explain the following, which is awaiting the user\'s approval.',
    '',
    'Payload:',
    '```',
    text,
    '```',
  ].join('\n')
}

/**
 * 按 `dsh-llm` 的 Message 结构字面构造一条 user 消息。
 *
 * 不 import `createUserMessage`：该工厂只做 `{ ...input, role: 'user' }`
 * 再 `structuredClone` + 深冻结，没有字段规范化，所以字面构造等价。
 *
 * @param text - 消息文本。
 * @returns 冻结前的用户消息对象。
 */
function userMessage(text) {
  return {
    id: `approval-explain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'approval-explain' },
  }
}

/**
 * 从 agent 解析这次调用该用哪个 provider/model。
 *
 * 顺序与 `dsh-compaction-basic` 一致：会话已路由的请求头优先，其次落到
 * Agent 自身声明的选项。两者都取不到时**失败要响** —— 静默降级会让按钮
 * 看起来「没反应」，那是最难查的故障。
 *
 * @param agent - 执行该命令的 agent。
 * @returns provider 与 model。
 * @throws 当两者都无法确定时。
 */
function resolveRoute(agent) {
  const routed = agent?.session?.requestHeader?.()?.config
  if (routed !== undefined
    && typeof routed.provider === 'string' && routed.provider.length > 0
    && typeof routed.model === 'string' && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const options = agent?.options
  if (options !== undefined
    && typeof options.provider === 'string' && options.provider.length > 0
    && typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  throw new Error(
    'approval-explain: 无法确定 provider/model —— 该会话还没有已路由的请求，'
    + '且 Agent 未声明 provider/model',
  )
}

/**
 * 把流式块累积成纯文本。
 *
 * `ctx.llm` 只有流式入口（没有非流式 API）。这里只关心文本块：
 * `text-delta` 按 index 累积，`block-end` 的 text 块作为权威覆盖。
 * 流结束用 `finish` 判定是否正常收尾。
 *
 * @param chunks - 异步块流。
 * @returns 文本与结束原因。
 */
async function collectText(chunks) {
  const byIndex = new Map()
  let finish
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      const index = chunk.index ?? 0
      byIndex.set(index, (byIndex.get(index) ?? '') + chunk.text)
    } else if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block !== null && typeof block === 'object' && block.type === 'text') {
        byIndex.set(chunk.index ?? 0, block.text ?? '')
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  const text = [...byIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value)
    .join('\n')
    .trim()
  return { text, finish }
}

/**
 * 判断结束原因是否可接受。
 *
 * 适配器把失败规范化成终止用的 `finish` 块而不是抛出，所以必须显式检查。
 *
 * @param finish - 流结束原因，可能缺失。
 * @returns 不可接受时的错误说明，否则 undefined。
 */
function finishProblem(finish) {
  if (finish === undefined) return '模型流没有给出结束原因'
  const kind = finish?.kind
  if (kind === 'stop' || kind === 'max-tokens') return undefined
  const detail = finish?.failure?.message
  return `模型调用未正常结束 (${String(kind)})${detail === undefined ? '' : `: ${detail}`}`
}

/**
 * 调一次模型并取回纯文本。
 *
 * @param ctx - 已注入 `commands` 的主机上下文。
 * @param agent - 目标 agent，用于路由与用量归属。
 * @param text - 要解释的内容。
 * @param signal - 上游取消信号。
 * @returns 模型输出的文本。
 */
async function explainWithLlm(ctx, agent, text, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('approval-explain: llm 服务不可用（该部署没有挂载模型提供方？）')
  }

  const route = resolveRoute(agent)
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [userMessage(userText(text))],
    system: systemPrompt(),
    maxTokens: MAX_OUTPUT_TOKENS,
  }
  const sessionId = agent?.session?.id
  if (sessionId !== undefined) options.sessionId = sessionId
  if (signal !== undefined) options.signal = signal

  const { text: output, finish } = await collectText(llm.stream(options))
  const problem = finishProblem(finish)
  if (problem !== undefined) throw new Error(`approval-explain: ${problem}`)
  if (output === '') throw new Error('approval-explain: 模型没有返回任何文本')
  return output
}

/**
 * 注册 `/explain` 命令。
 *
 * handler 是 `apply` 内的闭包，因此能直接用注入进来的主机 `ctx`；
 * `CommandInvocation` 只带 commandId / agent / rawInput / attachments / signal。
 *
 * @param ctx - 主机根上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: EXPLAIN_COMMAND,
    description: '解释一段命令或文件写入想做什么、读写改了什么、是否安全',
    input: { hint: '<要解释的命令或内容>' },
    handler: async (invocation) => {
      // rawInput 保留前导分隔空白（解析器只切掉 `/name`），必须自己 trim。
      const text = String(invocation.rawInput ?? '').trim()
      if (text === '') {
        return { kind: 'error', text: '用法：/explain <要解释的命令或内容>' }
      }
      try {
        const summary = await explainWithLlm(ctx, invocation.agent, text, invocation.signal)
        return { kind: 'success', text: summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: message }
      }
    },
  }), 'approval-explain: /explain command')
}

export const name = 'approval-explain'
export const inject = ['commands']
