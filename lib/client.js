/**
 * approval-explain —— 浏览器半（预构建产物）。
 *
 * ## 这个文件为什么是手写的
 *
 * 正常流程是 `pnpm --filter <pkg> bundle`（tsdown）产出。本机没有 pnpm/tsdown，
 * 而浏览器产物的格式本身很简单，就是一个注册到 module table 的惰性闭包：
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * `require` 由 shell 的 module table 在运行时注入，基线模块（react、
 * ui-primitives、ui-slots 等）都由它提供 —— **浏览器半因此不受
 * 「仓库外插件找不到 node_modules」的影响**，那是主机半独有的问题。
 * 同一份源码在别处用 tsdown 构建也能得到等价产物。
 *
 * ## 它做什么
 *
 * 接管审批卡片（`conversation.composer` 这条 chain 插槽），渲染出与官方
 * `ui-approval` 相同的结构，但**把「解释」按钮放进「拒绝 / 允许一次」那一行**，
 * 并在下方就地展开模型给出的「做什么 / 读写改 / 安全」三行结论。
 *
 * ## 为什么要接管整张卡片
 *
 * 「拒绝 / 允许一次」那一行由 `ui-approval` 的 `ApprovalPanel` 自己渲染，
 * 它**没有对外暴露插槽** —— 插槽树里 `conversation.composer` 之下只有
 * `conversation.approval.detail` 一个子插槽，而那个座位在 body 内。
 * 要把按钮放进 actionRow，只能接管整张卡片。
 *
 * `conversation.composer` 是 `chain` 插槽：按 priority 升序选举，
 * 第一个 `select` 返回非 null 的条目渲染，且 chain **不做占位检查**
 * （只要求 `select` 存在），所以多个条目可以共存。官方 `ui-approval`
 * 在 priority 1 且不带额外判别（任何 `PendingApproval` 都接）。这里注册
 * priority 0 —— 比它更小，所以审批这条路径上由本插件先接；`select`
 * 遇到非审批的待处理交互时返回 `null`，官方那条照常工作。
 *
 * ## 为什么不声明 conversation.approval.detail 子插槽
 *
 * 那个座位由官方 `ui-approval` 自己声明。`SlotCore.register` 对
 * `options.children` 的占用检查在 kind 分支**之后**，对**所有** kind 生效：
 * 重复声明同一个 key 会抛 `slot "..." is already declared`，而谁先谁后
 * 取决于 Cordis 的激活顺序 —— 于是「两边都声明」会随机炸掉审批面板。
 *
 * 本插件不需要那个座位：它已经用 `payloadOf` 复刻了 `ui-chat`
 * `ApprovalCommand` 的提取逻辑（只认 `args.command`），并额外兼容了
 * write/edit 那类 `file_path`/`path` 调用。所以这里**不声明、不渲染**它，
 * 冲突从根上不存在。
 *
 * 本插件**不禁用** dsh 的任何 Loader 行：卸载或加载失败时，官方面板原样回来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-explain',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const createElement = React.createElement
    const useState = React.useState
    const useCallback = React.useCallback
    const useMemo = React.useMemo

    /** 字典命名空间。 */
    const NS = 'approvalExplain'

    /** 简体中文词典（key 集合的真相源）。 */
    const zh = {
      'explain.trigger': '解释',
      'explain.busy': '解释中…',
      'explain.title': '让模型解释这次操作',
      'explain.empty': '这次调用没有可读的命令文本（参数里没有 command 字段）。',
      'explain.failed': '解释失败',
    }

    /** 英文词典，key 与中文完全一致。 */
    const en = {
      'explain.trigger': 'Explain',
      'explain.busy': 'Explaining…',
      'explain.title': 'Ask the model to explain this operation',
      'explain.empty': 'This call carries no readable command text (its arguments have no `command` field).',
      'explain.failed': 'Explanation failed',
    }

    /**
     * 复用官方 `approval` 命名空间的文案。
     *
     * 本插件接管了官方面板，必须自己渲染「等待审批 / 拒绝 / 允许一次」。
     * 这些 key 由 `ui-approval` 注册（waiting / detail.aria / reject /
     * allowOnce / escalation），用 `locale.bind` 读出来，
     * 避免硬编码 —— 也保证跟随语言切换。
     *
     * @param ctx - 浏览器上下文。
     * @returns 拼接官方词典的 t 函数；不可用时回落到内置英文。
     */
    function officialApprovalText(ctx) {
      const fallback = {
        waiting: 'Waiting for approval',
        'detail.aria': 'Approval details',
        reject: 'Reject',
        allowOnce: 'Allow once',
        escalation: 'Tool {toolName} requests privileged execution',
      }
      let bound
      try {
        bound = ctx.locale.bind('approval')
      } catch {
        bound = undefined
      }
      return (key, params) => {
        if (typeof bound === 'function') {
          const value = bound(key, params)
          // 未注册的 key 通常回显原 key；这种情况用回落文案。
          if (typeof value === 'string' && value !== key) return value
        }
        const template = fallback[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (whole, name) =>
          (params[name] === undefined ? whole : String(params[name])))
      }
    }

    /**
     * 从工具调用参数里取出可读文本。
     *
     * 与 `ui-chat` 的 `commandOf` 一致：优先 `command`。另兼容
     * `file_path` / `path` + 内容这类写入型调用，让原本留白的卡片有东西可显示。
     * @param argsRaw - 工具调用的原始参数 JSON。
     * @returns 可读文本，取不到时 undefined。
     */
    function payloadOf(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
      let args
      try {
        args = JSON.parse(argsRaw)
      } catch {
        return undefined
      }
      if (args === null || typeof args !== 'object') return undefined
      if (typeof args.command === 'string') return args.command

      const target = typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string' ? args.path : undefined
      if (target !== undefined) {
        const body = typeof args.content === 'string'
          ? args.content
          : typeof args.new_string === 'string' ? args.new_string : undefined
        return body === undefined ? target : `${target}\n\n${body}`
      }
      return undefined
    }

    const rootStyle = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '8px calc(var(--dsh-composer-side-clearance) + 16px) 12px',
    }
    const cardStyle = {
      overflow: 'hidden',
      width: '100%',
      maxWidth: 'var(--dsh-chat-content-width)',
      border: '1px solid var(--dsw-alias-state-warn-secondary)',
      borderRadius: '20px',
      background: 'var(--dsw-specific-input-major)',
      boxShadow: 'var(--dsw-shadow-lv2)',
    }
    const stripStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 16px',
      background: 'var(--dsw-alias-state-warn-tertiary)',
      color: 'var(--dsw-alias-state-warn-primary)',
      fontSize: '13px',
      lineHeight: '18px',
    }
    const dotStyle = {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: 'var(--dsw-alias-state-warn-primary)',
    }
    const bodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      boxSizing: 'border-box',
      maxHeight: 'var(--dsh-composer-text-max-height)',
      overflowY: 'auto',
      padding: '12px 16px 0',
    }
    const headlineStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '15px',
      fontWeight: 500,
      lineHeight: '24px',
    }
    const detailStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontFamily: 'var(--ds-font-family-code)',
      fontSize: '13px',
      lineHeight: '20px',
      wordBreak: 'break-all',
      whiteSpace: 'pre-wrap',
    }
    const actionRowStyle = {
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: '8px',
      padding: '14px 16px',
    }
    const spacerStyle = { flex: '1 1 auto' }
    const answerStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      padding: '0 16px 14px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
    }

    /**
     * 审批卡片：命令详情 + 与「拒绝/允许一次」同行的「解释」按钮 + 就地展开的结论。
     *
     * @param props - chain 选举出的 `matched`（PendingApproval）、标准座位、`t`、注入面。
     * @returns 整张审批卡片。
     */
    function ApprovalExplainCard(props) {
      const pending = props.matched
      const t = props.t
      const ta = props.ta
      const remote = props.remote
      const useChat = props.useChat

      const [answered, setAnswered] = useState(false)
      const [busy, setBusy] = useState(false)
      const [explanation, setExplanation] = useState(null)
      const [failure, setFailure] = useState(null)

      const answer = useCallback((outcome) => {
        setAnswered(true)
        Promise.resolve(pending.answer(outcome)).catch(() => { setAnswered(false) })
      }, [pending])

      const subject = useChat((snapshot) => {
        if (pending.callId === undefined) return undefined
        for (const node of snapshot.nodes.values()) {
          const root = node.kind === 'tool-call' ? node.data.root : undefined
          if (root !== undefined && root.callId === pending.callId && !('kind' in root)) {
            return payloadOf(root.argsRaw)
          }
        }
        return undefined
      })

      const run = useCallback(() => {
        if (busy || subject === undefined) return
        setBusy(true)
        setFailure(null)
        void (async () => {
          try {
            const result = await remote.commands.execute(
              pending.sessionId, `/explain ${subject}`, [],
            )
            if (!result.ok) {
              setFailure(`${result.error.message} (${result.error.code})`)
              return
            }
            if (result.value === undefined) {
              setFailure('未知命令: /explain')
              return
            }
            const outcome = result.value.result
            if (outcome.kind === 'error') {
              setFailure(outcome.text)
              return
            }
            setExplanation(outcome.text ?? '')
          } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        })()
      }, [busy, subject, remote, pending.sessionId])

      const lines = useMemo(
        () => (explanation === null
          ? []
          : explanation.split('\n').filter((line) => line.trim() !== '')),
        [explanation],
      )

      // 「解释」与「拒绝 / 允许一次」同一行：解释靠左，两个决定靠右。
      const actionRow = createElement('div', { style: actionRowStyle }, [
        createElement(primitives.Button, {
          key: 'explain',
          variant: 'ghost',
          size: 'sm',
          disabled: busy || subject === undefined,
          title: t('explain.title'),
          onClick: run,
        }, busy ? t('explain.busy') : t('explain.trigger')),
        createElement('div', { key: 'spacer', style: spacerStyle }),
        createElement(primitives.Button, {
          key: 'reject',
          variant: 'outline',
          disabled: answered,
          onClick: () => { answer('rejected') },
        }, ta('reject')),
        createElement(primitives.Button, {
          key: 'allow',
          variant: 'primary',
          disabled: answered,
          onClick: () => { answer('allowed-once') },
        }, ta('allowOnce')),
      ])

      const bodyChildren = [
        createElement('div', { key: 'headline', style: headlineStyle },
          pending.reason ?? ta('escalation', { toolName: pending.toolName })),
        createElement('div', { key: 'detail', style: detailStyle },
          subject ?? t('explain.empty')),
      ]

      const children = [
        createElement('div', { key: 'strip', style: stripStyle }, [
          createElement('span', { key: 'dot', style: dotStyle }),
          ta('waiting'),
        ]),
        createElement('div', {
          key: 'body',
          style: bodyStyle,
          'data-approval-scroll': '',
          tabIndex: 0,
          role: 'group',
          'aria-label': ta('detail.aria'),
        }, bodyChildren),
        actionRow,
      ]

      if (failure !== null || lines.length > 0) {
        const answerChildren = []
        if (failure !== null) {
          answerChildren.push(createElement('div', { key: 'fail' },
            `${t('explain.failed')}: ${failure}`))
        }
        for (let index = 0; index < lines.length; index += 1) {
          answerChildren.push(createElement('div', { key: `line-${index}` }, lines[index]))
        }
        children.push(createElement('div', { key: 'answer', style: answerStyle }, answerChildren))
      }

      return createElement('div', {
        key: pending.key,
        style: rootStyle,
        'data-approval-key': pending.key,
      }, createElement('div', { style: cardStyle }, children))
    }

    /**
     * 注册字典与审批卡片接管。
     *
     * `remote` 与 `remote.commands` 都要声明 —— 前者是服务本身，后者是命名空间门。
     * 刻意**不**声明 `conversation.approval.detail`：那个座位归官方
     * `ui-approval`，重复声明会因激活顺序不确定而随机抛错（详见文件头注释）。
     *
     * @param ctx - 浏览器根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approval-explain: dictionaries')
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        // chain 插槽按 priority 升序选举；官方 ui-approval 在 1，这里 0 先接。
        priority: 0,
        select: ({ pendingInteraction }) =>
          (pendingInteraction !== null
            && typeof pendingInteraction === 'object'
            && pendingInteraction.kind === 'approval'
            && typeof pendingInteraction.answer === 'function'
            ? pendingInteraction
            : null),
        locale: NS,
        inject: () => ({
          ta: officialApprovalText(ctx),
          remote: ctx.remote,
        }),
      }, ApprovalExplainCard))
    }

    exports.NS = NS
    exports.zh = zh
    exports.en = en
    exports.ApprovalExplainCard = ApprovalExplainCard
    exports.payloadOf = payloadOf
    exports.officialApprovalText = officialApprovalText
    exports.apply = apply
    exports.inject = ['slots', 'locale', 'remote', 'remote.commands']
    return module.exports
  },
})
