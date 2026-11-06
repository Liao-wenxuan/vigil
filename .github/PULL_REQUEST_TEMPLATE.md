name: 改动
description: 一个 PR 只做一件事
labels: ["需要评审"]
body:
  - type: markdown
    attributes:
      value: |
        ## 这次改了什么

        写清楚**为什么**改，而不是只写改了什么 ——
        后面的人需要知道动机，光看 diff 看不出来。

  - type: textarea
    id: why
    attributes:
      label: 为什么
    validations:
      required: true

  - type: textarea
    id: how
    attributes:
      label: 怎么改的
      description: 关键取舍，特别是**你放弃了哪个方案、为什么**

  - type: textarea
    id: verification
    attributes:
      label: 验证
      description: 跑了哪些命令，输出是什么
      placeholder: |
        npm run typecheck  ✓
        npm run test       ✓ 285 条
        npm run audit:ui  ✓
    validations:
      required: true

  - type: textarea
    id: risk
    attributes:
      label: 风险与回滚
      description: 哪些地方可能出问题？怎么退回去？
