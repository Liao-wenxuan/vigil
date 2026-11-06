name: 问题反馈
description: 报告一个可复现的问题
labels: ["需要复现"]
body:
  - type: markdown
    attributes:
      value: |
        谢谢反馈。请尽量带上**能直接复现的命令或步骤**，
        以及「看到的现象 vs 期望的现象」。

        ⚠️ 贴日志前请脱敏：里面可能含 token、URL 参数、邮箱。

  - type: textarea
    id: what-happened
    attributes:
      label: 发生了什么
      description: 你看到了什么
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: 你期望什么
    validations:
      required: true

  - type: textarea
    id: repro
    attributes:
      label: 复现步骤
      description: 命令或操作步骤
      placeholder: |
        npm run verify
        # 或者：启动 demo 后打开 http://localhost:5174/slo
    validations:
      required: true

  - type: input
    id: env
    attributes:
      label: 环境
      placeholder: Node 22 / SQLite 或 PostgreSQL / 浏览器与版本

  - type: textarea
    id: logs
    attributes:
      label: 相关日志或响应
      description: 脱敏后粘贴
